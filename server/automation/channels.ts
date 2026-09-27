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

// ---------------------------------------------------------------------------
// La bonne alternance : API officielle d'envoi de candidature (POST /job/v1/apply)
// La candidature est transmise par email au recruteur par La bonne alternance.
// Habilitation « applications:write » : automatique avec une clé bac à sable, sur demande en production.
// ---------------------------------------------------------------------------
type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export function splitName(fullName: string): { first: string; last: string } {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first: parts[0] || "", last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** Téléphone au format national (10 chiffres) quand c'est possible. */
export function normalizePhone(phone: string): string {
  const digits = String(phone || "").replace(/[^\d+]/g, "");
  if (/^\+33\d{9}$/.test(digits)) return `0${digits.slice(3)}`;
  if (/^0033\d{9}$/.test(digits)) return `0${digits.slice(4)}`;
  return digits;
}

export class LbaChannel implements ApplyChannel {
  readonly id = "lba";
  readonly label = "La bonne alternance (API officielle)";

  constructor(private opts: { apiKey?: string; baseUrl?: string; fetch?: HttpFetch }) {}

  canHandle(job: any) {
    return !!this.opts.apiKey && !!job?.lbaRecipientId;
  }

  async apply(ctx: ChannelContext): Promise<ChannelOutcome> {
    if (!ctx.documents.cvPdfBase64) return { kind: "unavailable", reason: "CV PDF indisponible (compilateur LaTeX absent)" };
    const { first, last } = splitName(ctx.candidate?.fullName);
    const email = String(ctx.candidate?.email || "").trim();
    const phone = normalizePhone(ctx.candidate?.phone);
    const missing = [!first && "prénom", !last && "nom", !email && "email", !phone && "téléphone"].filter(Boolean);
    if (missing.length) return { kind: "unavailable", reason: `profil incomplet (${missing.join(", ")})` };

    const body = {
      applicant_first_name: first.slice(0, 50),
      applicant_last_name: last.slice(0, 50),
      applicant_email: email,
      applicant_phone: phone,
      applicant_attachment_name: `CV_${safeFilename(ctx.candidate?.fullName)}.pdf`,
      applicant_attachment_content: ctx.documents.cvPdfBase64,
      applicant_message: ctx.documents.coverLetter || null,
      recipient_id: String(ctx.job.lbaRecipientId)
    };
    const base = (this.opts.baseUrl || "https://api.apprentissage.beta.gouv.fr/api").replace(/\/$/, "");
    const doFetch: HttpFetch = this.opts.fetch || ((url, init) => fetch(url, init) as any);
    let res;
    try {
      res = await doFetch(`${base}/job/v1/apply`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
      });
    } catch (e: any) {
      throw new RetryableError(`La bonne alternance injoignable : ${e?.message || e}`);
    }
    // Limite : 10 envois par minute pour tout le service
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`La bonne alternance indisponible (${res.status})`);
    if (res.status === 401 || res.status === 403) return { kind: "unavailable", reason: "clé La bonne alternance sans droit d'envoi (habilitation applications:write)" };
    if (!res.ok) {
      const detail = await res.json().then((d: any) => d?.message).catch(() => "");
      return { kind: "unavailable", reason: `candidature refusée par La bonne alternance (${res.status}${detail ? ` : ${detail}` : ""})` };
    }
    const data = await res.json().catch(() => ({}));
    return { kind: "submitted", reference: data?.id ? String(data.id) : undefined, details: { via: "La bonne alternance", recipientId: body.recipient_id } };
  }
}
