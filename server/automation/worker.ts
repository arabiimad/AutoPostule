/**
 * Worker d'auto-candidature : traite les tâches de la file durable, indépendamment de tout navigateur.
 *
 * Traitement d'une offre (process_offer) :
 *   1. politique active et non en pause ;
 *   2. qualification (critères bloquants, adéquation) ;
 *   3. canal résolu par le serveur (email publié, Lever, Greenhouse) ; plateforme ou site inconnu → action du candidat ;
 *   4. CV et lettre préparés et vérifiés ; vérification négative ou indisponible → validation du candidat ;
 *   5. réservation atomique (activation, pause, limite du jour, aucun envoi antérieur) ;
 *   6. revérification de la pause, passage « envoi en cours », envoi ;
 *   7. preuve conservée. Sans réponse du fournisseur : « résultat incertain », jamais de nouvel envoi aveugle.
 */
import { createHash } from "node:crypto";
import type { AutomationStore, Task, TaskStatus, MailConnection } from "./store.ts";
import { classifyReply, type InboundMessage } from "./replies.ts";
import { qualifyOffer, type AutomationPolicy } from "./policy.ts";
import { resolveApplyChannel, isAutomatable, type ApplyChannel } from "./channels.ts";
import { MailSendError, decryptToken, encryptToken, sha256, type MailProvider, type OutgoingMail, type SendResult } from "./email.ts";
import type { PreparedCv, PreparedLetter } from "../services/documents.ts";
import type { FormInput, FormResult } from "./forms.ts";

export interface Outcome {
  status: Exclude<TaskStatus, "running">;
  message: string;
  retrySeconds?: number;
}

export interface WorkerDeps {
  store: AutomationStore;
  workerId: string;
  prepare(profile: any, offer: any): Promise<{ cv: PreparedCv; letter: PreparedLetter; ready: { ok: boolean; reasons: string[] } }>;
  renderCvPdf(profile: any, cv: PreparedCv, offer: any): Promise<Buffer>;
  sendMail(provider: MailProvider, accessToken: string, mail: OutgoingMail): Promise<SendResult>;
  refreshAccessToken(provider: MailProvider, refreshToken: string): Promise<{ accessToken: string; expiresAt: string; refreshToken?: string }>;
  searchOffers?(policy: AutomationPolicy, profile: any): Promise<any[]>;
  /** Formulaire Lever / Greenhouse (navigateur côté serveur). beforeSubmit revérifie la pause juste avant le clic. */
  fetchReplies?(provider: MailProvider, token: string, destination: string, since: string): Promise<InboundMessage[]>;
  submitForm?(channel: Extract<ApplyChannel, { kind: "lever" | "greenhouse" }>, input: FormInput, beforeSubmit: () => Promise<boolean>): Promise<FormResult>;
  now?: () => Date;
}

const done = (message: string): Outcome => ({ status: "done", message });
const needsUser = (message: string): Outcome => ({ status: "needs_user", message });
const retry = (message: string, retrySeconds: number): Outcome => ({ status: "queued", message, retrySeconds });

/** Identifiant stable du dossier affiché dans l'application pour une offre traitée automatiquement. */
export const autoApplicationId = (offerId: string) => `auto-${createHash("sha1").update(offerId).digest("hex").slice(0, 16)}`;

const profileVersion = (profile: any) => createHash("sha256").update(JSON.stringify(profile ?? {})).digest("hex").slice(0, 16);

function secondsUntilTomorrowParis(now: Date): number {
  const paris = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Paris" }));
  const next = new Date(paris);
  next.setHours(24, 5, 0, 0); // 00 h 05 heure de Paris
  return Math.max(60, Math.round((next.getTime() - paris.getTime()) / 1000));
}

/** Jeton d'accès valide (renouvelé et stocké chiffré si besoin). Lève MailSendError(authExpired) si l'accès est révoqué. */
async function accessTokenFor(userId: string, conn: MailConnection, deps: WorkerDeps, now: Date): Promise<string> {
  const fresh = conn.accessTokenEnc && conn.expiresAt && new Date(conn.expiresAt).getTime() > now.getTime() + 120_000;
  if (fresh) return decryptToken(conn.accessTokenEnc!);
  const r = await deps.refreshAccessToken(conn.provider, decryptToken(conn.refreshTokenEnc!));
  await deps.store.saveMailTokens(userId, conn.provider, { accessTokenEnc: encryptToken(r.accessToken), ...(r.refreshToken ? { refreshTokenEnc: encryptToken(r.refreshToken) } : {}), expiresAt: r.expiresAt });
  return r.accessToken;
}

export const canTrackReplies = (conn: MailConnection | null) =>
  !!conn && conn.status === "active" && (conn.scopes || []).some((s) => /gmail\.readonly|Mail\.Read$/.test(s));

/**
 * Suivi des réponses : accusé de réception → envoi confirmé ; entretien / refus → statut du dossier mis à jour,
 * relance annulée, notification. Chaque message n'est traité qu'une fois.
 */
export async function trackReplies(task: Task, deps: WorkerDeps): Promise<Outcome> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  const conn = await store.getMailConnection(task.userId);
  if (!canTrackReplies(conn) || !deps.fetchReplies) return done("Suivi des réponses non autorisé.");
  let token: string;
  try {
    token = await accessTokenFor(task.userId, conn!, deps, now);
  } catch (e: any) {
    if (e instanceof MailSendError && e.authExpired) {
      await store.saveMailTokens(task.userId, conn!.provider, { status: "revoked" });
      return needsUser("Accès à la messagerie expiré : reconnectez-la.");
    }
    return retry("Messagerie momentanément indisponible.", 30 * 60);
  }
  let handled = 0;
  for (const a of await store.listTrackableAttempts(task.userId)) {
    const isForm = a.channel !== "email";
    // Formulaires : réponses envoyées par le logiciel de recrutement au nom de l'entreprise
    const target = isForm ? (a.channel === "lever" ? "no-reply@hire.lever.co" : "no-reply@greenhouse.io") : a.destination;
    let messages: InboundMessage[];
    try {
      messages = await deps.fetchReplies(conn!.provider, token, target, a.since);
    } catch {
      continue;
    }
    const company = a.company.toLowerCase();
    for (const m of messages.sort((x, y) => x.receivedAt.localeCompare(y.receivedAt))) {
      if (isForm && !`${m.from} ${m.subject}`.toLowerCase().includes(company)) continue;
      if (await store.hasProcessedReply(task.userId, m.id)) continue;
      const kind = classifyReply(m);
      handled++;
      await store.logEvent(task.userId, "reply", `Réponse de ${a.company} : ${kind === "interview" ? "proposition d'entretien" : kind === "rejection" ? "candidature non retenue" : kind === "acknowledgement" ? "accusé de réception" : "message reçu"}.`,
        { messageId: m.id, kind, offerId: a.offerId, subject: m.subject.slice(0, 160) }, { taskId: task.id, attemptId: a.attemptId });
      if (a.status !== "confirmed") await store.recordSubmission(a.attemptId, "confirmed", { confirmedBy: kind, messageId: m.id, at: m.receivedAt });
      a.status = "confirmed";
      const appPatch: Record<string, any> = { id: autoApplicationId(a.offerId) };
      if (kind === "interview") Object.assign(appPatch, { status: "interview", respondedAt: m.receivedAt, followUpAt: "" });
      else if (kind === "rejection") Object.assign(appPatch, { status: "rejected", respondedAt: m.receivedAt, followUpAt: "" });
      else if (kind === "other") Object.assign(appPatch, { respondedAt: m.receivedAt, followUpAt: "" });
      if (Object.keys(appPatch).length > 1) await store.upsertApplication(task.userId, appPatch);
      const titles: Record<string, string> = { interview: "Entretien proposé", rejection: "Réponse d'un recruteur", other: "Message d'un recruteur" };
      if (kind !== "acknowledgement") {
        await store.notify(task.userId, { title: titles[kind], body: `${a.company} — ${m.subject}`.slice(0, 180), url: "/?onglet=candidatures", tag: `reponse-${m.id}` }).catch(() => {});
      }
    }
  }
  return done(`${handled} réponse(s) traitée(s).`);
}

export async function processOffer(task: Task, deps: WorkerDeps): Promise<Outcome> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  const userId = task.userId;
  const policy = await store.getPolicy(userId);
  if (!policy?.enabled) return { status: "cancelled", message: "Automatisation désactivée." };
  if (policy.paused) return { status: "cancelled", message: "Automatisation en pause." };

  const [profile, offer] = await Promise.all([store.getProfile(userId), task.offerId ? store.getOffer(task.offerId) : null]);
  if (!offer) return { status: "failed", message: "Offre introuvable." };
  if (!profile?.experiences?.length) return needsUser("Profil incomplet : ajoutez au moins une expérience.");

  const q = qualifyOffer(policy, profile, offer, now);
  if (!q.ok) return done(`Offre écartée : ${q.reason}`);

  const appId = autoApplicationId(offer.id);
  const baseApp = {
    id: appId, userId, jobId: offer.id, jobTitle: offer.title, company: offer.company, location: offer.location || "",
    contractType: offer.contractType, jobUrl: offer.applyUrl || offer.url || "", jobDescription: offer.description || "",
    skillsRequired: offer.skillsRequired || [], matchScore: q.score, jobSource: offer.source || "", createdAt: now.toISOString()
  };

  const channel: ApplyChannel = offer.applyChannel || resolveApplyChannel(offer);
  const automatable = isAutomatable(channel, policy.channels);

  // Documents préparés dans tous les cas : le candidat retrouve un dossier prêt s'il doit agir lui-même
  const { cv, letter, ready } = await deps.prepare(profile, offer);
  const dossier = { tailoredContent: cv.tailored, offerAnalysis: cv.analysis, coverLetter: letter.letter };

  const intervention = async (reason: string, state = "needs_user") => {
    await store.upsertApplication(userId, {
      ...baseApp, ...dossier, status: "prepared",
      automation: { state, reason, channel: channel.kind, target: channel.target, updatedAt: now.toISOString() }
    });
    await store.logEvent(userId, "intervention", reason, { offerId: offer.id, channel: channel.kind }, { taskId: task.id });
    // Notification seulement quand une action de votre part débloque l'envoi (pas pour chaque offre de plateforme)
    if (channel.kind !== "platform" && channel.kind !== "unknown") {
      await store.notify(userId, { title: "Kareer : action demandée", body: `${offer.company} — ${reason}`.slice(0, 180), url: "/?onglet=assistant", tag: `offre-${offer.id}` }).catch(() => {});
    }
    return needsUser(reason);
  };


  if (!automatable) {
    if (channel.kind === "platform") return intervention(`Candidature à valider sur ${channel.platform} (envoi automatique interdit par la plateforme) : votre CV et votre lettre sont prêts.`);
    if (channel.kind === "unknown") return intervention("Site de candidature non pris en charge : votre CV et votre lettre sont prêts pour postuler vous-même.");
    return intervention("Ce canal n'est pas autorisé dans vos réglages d'automatisation.");
  }
  if (!ready.ok) return intervention(`Validation nécessaire avant l'envoi : ${ready.reasons.join(" ")}`);
  if (channel.kind === "lever" || channel.kind === "greenhouse") return submitByForm(task, deps, { profile, offer, channel, cv, letter, baseApp, dossier, intervention, now });

  // Messagerie connectée ?
  const conn = await store.getMailConnection(userId);
  if (!conn || conn.status !== "active" || !conn.refreshTokenEnc) {
    return intervention("Connectez votre messagerie (Gmail ou Outlook) pour que les candidatures partent depuis votre adresse.");
  }

  const pdf = await deps.renderCvPdf(profile, cv, offer);
  const cvName = `CV - ${String(profile.fullName || "Candidat").replace(/[\\/:*?"<>|]+/g, "")}.pdf`;
  const reservation = await store.reserveAttempt({
    userId, offerId: offer.id, channel: "email", destination: channel.target, profileVersion: profileVersion(profile),
    documents: [{ kind: "cv", name: cvName, sha256: sha256(pdf), bytes: pdf.length }, { kind: "letter", name: "corps du message", sha256: sha256(Buffer.from(letter.letter)), bytes: Buffer.byteLength(letter.letter) }],
    answers: {}
  });
  if (!reservation.attemptId) {
    switch (reservation.reason) {
      case "DAILY_LIMIT": return retry("Limite quotidienne atteinte : envoi reporté à demain.", secondsUntilTomorrowParis(now));
      case "ALREADY_ATTEMPTED": return done("Candidature déjà envoyée pour cette offre.");
      default: return { status: "cancelled", message: "Automatisation désactivée ou en pause." };
    }
  }
  const attemptId = reservation.attemptId;
  const refs = { taskId: task.id, attemptId };

  // Jeton d'accès valide (renouvelé si besoin)
  let accessToken: string;
  try {
    accessToken = await accessTokenFor(userId, conn, deps, now);
  } catch (e: any) {
    if (e instanceof MailSendError && e.authExpired) {
      await store.saveMailTokens(userId, conn.provider, { status: "revoked" });
      await store.recordSubmission(attemptId, "needs_user", null, "Accès à la messagerie révoqué.");
      return intervention("L'accès à votre messagerie a expiré ou a été retiré : reconnectez-la pour reprendre les envois.");
    }
    await store.recordSubmission(attemptId, "failed", null, String(e?.message || e).slice(0, 300));
    return retry("Messagerie momentanément indisponible : nouvel essai plus tard.", 15 * 60);
  }

  // Dernier contrôle (pause, désactivation) juste avant l'envoi
  const begin = await store.beginSubmission(attemptId);
  if (begin !== "OK") return { status: "cancelled", message: "Envoi annulé : automatisation en pause ou désactivée." };

  const mail: OutgoingMail = {
    from: conn.email,
    fromName: profile.fullName || undefined,
    to: channel.target,
    subject: `Candidature — ${offer.title}${offer.reference ? ` (réf. ${offer.reference})` : ""}`,
    text: letter.letter,
    attachments: [{ filename: cvName, contentType: "application/pdf", content: pdf }]
  };
  let sent: SendResult;
  try {
    sent = await deps.sendMail(conn.provider, accessToken, mail);
  } catch (e: any) {
    if (e instanceof MailSendError) {
      // Réponse explicite du fournisseur : le message n'a pas été accepté (rien n'est parti)
      await store.recordSubmission(attemptId, "failed", null, e.message.slice(0, 300));
      if (e.authExpired) {
        await store.saveMailTokens(userId, conn.provider, { status: "revoked" });
        return intervention("L'accès à votre messagerie a expiré : reconnectez-la pour reprendre les envois.");
      }
      if (e.retryable) return retry("Messagerie momentanément indisponible : nouvel essai plus tard.", 15 * 60);
      return intervention(`Envoi refusé par votre messagerie : ${e.message.slice(0, 160)}`);
    }
    // Aucune réponse (délai dépassé, coupure) : le message a pu partir. Jamais de nouvel envoi automatique.
    await store.recordSubmission(attemptId, "uncertain", null, String(e?.message || e).slice(0, 300));
    await store.upsertApplication(userId, {
      ...baseApp, ...dossier, status: "prepared",
      automation: { state: "uncertain", reason: "Résultat incertain : vérifiez vos messages envoyés avant de renvoyer.", channel: "email", target: channel.target, attemptId, updatedAt: now.toISOString() }
    });
    await store.logEvent(userId, "uncertain", `Résultat incertain pour ${offer.company} : vérifiez vos messages envoyés.`, { offerId: offer.id }, refs);
    await store.notify(userId, { title: "Envoi à vérifier", body: `${offer.company} : vérifiez vos messages envoyés avant de renvoyer.`, url: "/?onglet=assistant", tag: `offre-${offer.id}` }).catch(() => {});
    return { status: "uncertain", message: "Résultat de l'envoi incertain." };
  }

  const proof = { provider: sent.provider, messageId: sent.messageId, acceptedAt: sent.acceptedAt, to: channel.target, evidence: (channel as any).evidence };
  await store.recordSubmission(attemptId, "submitted", proof);
  await store.upsertApplication(userId, {
    ...baseApp, ...dossier, status: "applied", appliedAt: sent.acceptedAt,
    followUpAt: new Date(now.getTime() + 7 * 864e5).toISOString(),
    automation: { state: "submitted", channel: "email", target: channel.target, attemptId, proof, updatedAt: now.toISOString() },
    logEvents: [{ timestamp: now.toLocaleString("fr-FR"), message: `Candidature envoyée automatiquement à ${channel.target} (acceptée par ${sent.provider === "gmail" ? "Gmail" : "Outlook"}).` }]
  });
  await store.logEvent(userId, "submitted", `Candidature envoyée à ${offer.company} (${channel.target}).`, { offerId: offer.id, proof }, refs);
  await store.notify(userId, { title: "Candidature envoyée", body: `${offer.title} — ${offer.company}`, url: "/?onglet=candidatures", tag: `offre-${offer.id}` }).catch(() => {});
  return done("Candidature envoyée.");
}

/** Envoi par formulaire (Lever, Greenhouse) : mêmes garanties que l'email (réservation, pause, preuve, incertitude). */
async function submitByForm(
  task: Task,
  deps: WorkerDeps,
  c: { profile: any; offer: any; channel: Extract<ApplyChannel, { kind: "lever" | "greenhouse" }>; cv: PreparedCv; letter: PreparedLetter; baseApp: any; dossier: any; intervention: (reason: string, state?: string) => Promise<Outcome>; now: Date }
): Promise<Outcome> {
  const { store } = deps;
  const { profile, offer, channel, now } = c;
  if (!deps.submitForm) return c.intervention("Envoi par formulaire indisponible sur ce serveur : votre dossier est prêt.");
  const pdf = await deps.renderCvPdf(profile, c.cv, offer);
  const cvName = `CV - ${String(profile.fullName || "Candidat").replace(/[\\/:*?"<>|]+/g, "")}.pdf`;
  const answers = await store.getPersonalAnswers(task.userId);
  const reservation = await store.reserveAttempt({
    userId: task.userId, offerId: offer.id, channel: channel.kind, destination: channel.target, profileVersion: profileVersion(profile),
    documents: [{ kind: "cv", name: cvName, sha256: sha256(pdf), bytes: pdf.length }, { kind: "letter", name: "lettre", sha256: sha256(Buffer.from(c.letter.letter)), bytes: Buffer.byteLength(c.letter.letter) }],
    answers
  });
  if (!reservation.attemptId) {
    switch (reservation.reason) {
      case "DAILY_LIMIT": return retry("Limite quotidienne atteinte : envoi reporté à demain.", secondsUntilTomorrowParis(now));
      case "ALREADY_ATTEMPTED": return done("Candidature déjà envoyée pour cette offre.");
      default: return { status: "cancelled", message: "Automatisation désactivée ou en pause." };
    }
  }
  const attemptId = reservation.attemptId;
  const refs = { taskId: task.id, attemptId };
  let begun = false;
  const result = await deps.submitForm(channel, { profile, cvPdf: pdf, cvFileName: cvName, letter: c.letter.letter, answers }, async () => {
    begun = (await store.beginSubmission(attemptId)) === "OK";
    return begun;
  }).catch((e: any): FormResult => begun
    ? { status: "uncertain", reason: `Erreur pendant l'envoi : ${String(e?.message || e).slice(0, 120)}` }
    : { status: "needs_user", reason: `Formulaire inaccessible : ${String(e?.message || e).slice(0, 120)}` });

  const site = channel.kind === "lever" ? "Lever" : "Greenhouse";
  if (result.status === "submitted") {
    const proof = { site, url: result.proof.url, confirmationText: result.proof.confirmationText, form: channel.target };
    await store.recordSubmission(attemptId, "submitted", proof);
    await store.upsertApplication(task.userId, {
      ...c.baseApp, ...c.dossier, status: "applied", appliedAt: now.toISOString(),
      followUpAt: new Date(now.getTime() + 7 * 864e5).toISOString(),
      automation: { state: "submitted", channel: channel.kind, target: channel.target, attemptId, proof, updatedAt: now.toISOString() },
      logEvents: [{ timestamp: now.toLocaleString("fr-FR"), message: `Candidature envoyée automatiquement par le formulaire ${site} (confirmation affichée).` }]
    });
    await store.logEvent(task.userId, "submitted", `Candidature envoyée à ${offer.company} (formulaire ${site}).`, { offerId: offer.id, proof }, refs);
    await store.notify(task.userId, { title: "Candidature envoyée", body: `${offer.title} — ${offer.company}`, url: "/?onglet=candidatures", tag: `offre-${offer.id}` }).catch(() => {});
    return done("Candidature envoyée.");
  }
  if (result.status === "uncertain") {
    await store.recordSubmission(attemptId, "uncertain", null, result.reason);
    await store.upsertApplication(task.userId, {
      ...c.baseApp, ...c.dossier, status: "prepared",
      automation: { state: "uncertain", reason: "Résultat incertain : vérifiez vos emails (accusé de réception) avant de renvoyer.", channel: channel.kind, target: channel.target, attemptId, updatedAt: now.toISOString() }
    });
    await store.logEvent(task.userId, "uncertain", `Résultat incertain pour ${offer.company} (formulaire ${site}).`, { offerId: offer.id }, refs);
    await store.notify(task.userId, { title: "Envoi à vérifier", body: `${offer.company} : cherchez l'accusé de réception avant de renvoyer.`, url: "/?onglet=assistant", tag: `offre-${offer.id}` }).catch(() => {});
    return { status: "uncertain", message: result.reason };
  }
  if (result.status === "cancelled") return { status: "cancelled", message: result.reason };
  await store.recordSubmission(attemptId, "needs_user", null, result.reason);
  if (result.questions?.length) {
    await store.logEvent(task.userId, "questions", "Questions à compléter pour les prochaines candidatures.", { offerId: offer.id, questions: result.questions }, refs);
  }
  return c.intervention(result.reason);
}

/** Recherche planifiée : nouvelles offres qualifiées ajoutées à la file (sans doublon). */
export async function runSearch(task: Task, deps: WorkerDeps): Promise<Outcome> {
  const { store } = deps;
  const policy = await store.getPolicy(task.userId);
  if (!policy?.enabled || policy.paused) return { status: "cancelled", message: "Automatisation désactivée ou en pause." };
  if (!deps.searchOffers) return { status: "failed", message: "Recherche indisponible." };
  const profile = await store.getProfile(task.userId);
  const offers = await deps.searchOffers(policy, profile);
  await store.upsertOffers(offers);
  let queued = 0;
  for (const o of offers) {
    if (queued >= policy.dailyLimit * 2) break;
    if (!qualifyOffer(policy, profile, o, deps.now?.() ?? new Date()).ok) continue;
    if (await store.enqueue({ userId: task.userId, kind: "process_offer", offerId: o.id })) queued++;
  }
  await store.logEvent(task.userId, "search", `${offers.length} offre(s) trouvée(s), ${queued} retenue(s) pour candidature.`, { found: offers.length, queued }, { taskId: task.id });
  if (queued > 0) {
    await store.notify(task.userId, { title: "Nouvelles offres pour vous", body: `${queued} offre(s) correspondent à vos critères : candidatures en préparation.`, url: "/?onglet=assistant", tag: "recherche" }).catch(() => {});
  }
  return done(`${queued} offre(s) ajoutée(s) à la file.`);
}

/** Réserve et traite un lot de tâches. Une erreur imprévue remet la tâche en file (réessai différé). */
export async function runOnce(deps: WorkerDeps, opts: { limit?: number; leaseSeconds?: number } = {}): Promise<number> {
  const tasks = await deps.store.claimTasks(deps.workerId, opts.limit ?? 2, opts.leaseSeconds ?? 600);
  for (const task of tasks) {
    let outcome: Outcome;
    try {
      outcome = task.kind === "process_offer" ? await processOffer(task, deps)
        : task.kind === "search" ? await runSearch(task, deps)
        : task.kind === "track_replies" ? await trackReplies(task, deps)
        : { status: "failed", message: `Type de tâche non géré : ${task.kind}` };
    } catch (e: any) {
      outcome = retry(`Erreur imprévue : ${String(e?.message || e).slice(0, 200)}`, 5 * 60 * task.attempts);
    }
    await deps.store.finishTask(task.id, deps.workerId, outcome.status, outcome.status === "done" ? null : outcome.message, outcome.retrySeconds);
  }
  return tasks.length;
}
