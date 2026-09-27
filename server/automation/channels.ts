/**
 * Canaux d'envoi d'une candidature, essayés dans l'ordre de préférence :
 * API officielle → email au recruteur → formulaire (script dédié ou agent navigateur) → étape manuelle.
 *
 * Chaque canal dit s'il peut traiter l'offre, puis renvoie :
 *  - submitted   : candidature envoyée ;
 *  - needs_user  : pause (question, captcha, code…) ; le canal reprendra avec la réponse ;
 *  - unavailable : ce canal ne peut pas finalement ; on passe au suivant.
 * Une erreur passagère (réseau, site indisponible) est levée avec RetryableError.
 */
import type { FormQuestion, ResolvedAnswer } from "./answers.ts";
import type { Vault } from "./vault.ts";
import type { PendingAction, PendingQuestion, PreparedDocuments, Resolution, Task } from "./types.ts";

export class RetryableError extends Error {}

export interface ChannelContext {
  uid: string;
  task: Task;
  job: any;
  candidate: any;
  documents: PreparedDocuments;
  resolution: Resolution;
  vault: Vault;
  /** Canaux essayés sans succès avant celui-ci, avec la raison (montrés à l'utilisateur). */
  skipped: string[];
  /** Résout les questions d'un formulaire (réponses enregistrées, profil, IA). */
  answer(questions: FormQuestion[]): Promise<{ resolved: ResolvedAnswer[]; unresolved: PendingQuestion[] }>;
}

export type ChannelOutcome =
  | { kind: "submitted"; reference?: string; details: Record<string, unknown> }
  | { kind: "needs_user"; pending: Omit<PendingAction, "createdAt"> }
  | { kind: "unavailable"; reason: string };

export interface ApplyChannel {
  readonly id: string;
  readonly label: string;
  canHandle(job: any, uid: string): Promise<boolean> | boolean;
  apply(ctx: ChannelContext): Promise<ChannelOutcome>;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  attachments: { filename: string; contentBase64: string; contentType: string }[];
}

/** Boîte d'envoi de l'utilisateur (Gmail ou Outlook via OAuth, ou simulée). */
export interface MailSender {
  readonly kind: string;
  readonly from: string;
  send(message: MailMessage): Promise<{ messageId: string }>;
}

/** Boîte simulée : garde les messages en mémoire (tests, développement). */
export class SimulatedMailSender implements MailSender {
  readonly kind = "simulated";
  outbox: MailMessage[] = [];
  constructor(readonly from: string) {}
  async send(message: MailMessage) {
    this.outbox.push(message);
    return { messageId: `simulated-${this.outbox.length}` };
  }
}

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i;

export function recruiterEmail(job: any): string | null {
  const candidates = [job?.contactEmail, job?.applyEmail, String(job?.applyUrl || "").match(/^mailto:([^?]+)/i)?.[1]];
  for (const c of candidates) {
    const v = decodeURIComponent(String(c || "")).trim();
    if (EMAIL_RE.test(v)) return v;
  }
  return null;
}

function safeFilename(s: string) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "Candidat";
}

export class EmailChannel implements ApplyChannel {
  readonly id = "email";
  readonly label = "Email au recruteur";
  constructor(private mailFor: (uid: string) => Promise<MailSender | null>) {}

  async canHandle(job: any, uid: string) {
    return !!recruiterEmail(job) && !!(await this.mailFor(uid));
  }

  async apply(ctx: ChannelContext): Promise<ChannelOutcome> {
    const to = recruiterEmail(ctx.job);
    const sender = await this.mailFor(ctx.uid);
    if (!to || !sender) return { kind: "unavailable", reason: "aucune adresse de recruteur ou boîte mail non connectée" };
    // On n'envoie jamais le code LaTeX à un recruteur : il faut le PDF
    if (!ctx.documents.cvPdfBase64) return { kind: "unavailable", reason: "CV PDF indisponible (compilateur LaTeX absent)" };

    const name = String(ctx.candidate?.fullName || "").trim();
    const title = String(ctx.job?.title || "").replace(/^Candidature spontanée — /, "");
    const subject = ctx.job?.isSpontaneous ? `Candidature spontanée — ${title}` : `Candidature — ${title}${ctx.job?.reference ? ` (réf. ${ctx.job.reference})` : ""}`;
    const res = await sender.send({
      to,
      subject,
      text: ctx.documents.coverLetter,
      replyTo: ctx.candidate?.email || undefined,
      attachments: [{ filename: `CV_${safeFilename(name)}.pdf`, contentBase64: ctx.documents.cvPdfBase64, contentType: "application/pdf" }]
    });
    return { kind: "submitted", reference: res.messageId, details: { to, from: sender.from, subject, mailbox: sender.kind } };
  }
}

// ---------------------------------------------------------------------------
// Étape manuelle (dernier recours) : dossier prêt, l'utilisateur termine l'envoi
// ---------------------------------------------------------------------------
export class ManualChannel implements ApplyChannel {
  readonly id = "manual";
  readonly label = "À terminer par l'utilisateur";

  canHandle() {
    return true;
  }

  async apply(ctx: ChannelContext): Promise<ChannelOutcome> {
    const url = String(ctx.job?.applyUrl || "");
    if (ctx.resolution.humanStepDone) {
      return { kind: "submitted", details: { url, completedBy: "user" } };
    }
    const why = ctx.skipped.length ? ` Envoi automatique impossible : ${ctx.skipped.join(" ; ")}.` : "";
    return {
      kind: "needs_user",
      pending: {
        kind: "manual_step",
        message: (url
          ? "CV et lettre sont prêts : il reste à les déposer sur la page de l'offre."
          : "CV et lettre sont prêts, mais aucun moyen d'envoi n'a été trouvé pour cette offre.") + why,
        ...(url ? { url } : {})
      }
    };
  }
}
