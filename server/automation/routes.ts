/**
 * API de l'agent : /api/automation/...
 *
 * Toutes les routes exigent un compte connecté (jeton Firebase), sauf /tick, appelée par
 * Cloud Scheduler avec l'en-tête x-automation-secret. En développement (AUTH_MODE=off),
 * l'en-tête x-dev-uid désigne l'utilisateur simulé.
 */
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { categorize, questionKey } from "./answers.ts";
import { jobKey, sanitizeSettings } from "./guardrails.ts";
import { TaskStateError } from "./store.ts";
import { VaultNotFoundError, VaultUnavailableError } from "./vault.ts";
import { MailAuthError } from "./gmail.ts";
import type { Automation } from "./index.ts";
import type { Task } from "./types.ts";

/** Version envoyée au navigateur : sans l'instantané du profil ni le PDF (volumineux). */
export function taskView(task: Task) {
  const { candidate, documents, ...payload } = task.payload;
  return {
    ...task,
    payload: {
      ...payload,
      documents: documents && { coverLetter: documents.coverLetter, notices: documents.notices, preparedAt: documents.preparedAt, hasPdf: !!documents.cvPdfBase64 }
    }
  };
}

function secretMatches(given: unknown, expected: string | undefined) {
  if (!expected || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAutomationRouter(automation: Automation, opts: { authMode: string; production: boolean }) {
  const router = express.Router();
  const { store, orchestrator, vault } = automation;

  const wrap = (fn: (req: any, res: express.Response) => Promise<unknown>) => async (req: any, res: express.Response) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      if (e instanceof TaskStateError) return res.status(e.status).json({ success: false, error: e.message });
      if (e instanceof VaultNotFoundError) return res.status(404).json({ success: false, error: e.message });
      if (e instanceof VaultUnavailableError) return res.status(503).json({ success: false, error: e.message });
      console.error("[Agent]", e);
      res.status(500).json({ success: false, error: "Erreur de l'agent de candidature." });
    }
  };

  // Cloud Scheduler (toutes les minutes) : traite les candidatures prêtes
  router.post("/tick", wrap(async (req, res) => {
    if (!secretMatches(req.headers["x-automation-secret"], process.env.AUTOMATION_CRON_SECRET)) {
      return res.status(401).json({ success: false, error: "Secret invalide" });
    }
    const limit = Math.min(50, Math.max(1, Number(req.body?.limit) || 10));
    res.json({ success: true, ...(await automation.tick({ limit })) });
  }));

  // Retour de Google après consentement (redirection du navigateur : pas de jeton Firebase, l'utilisateur est identifié par state)
  router.get("/mail/google/callback", async (req, res) => {
    const back = (status: string, message?: string) => {
      const qs = new URLSearchParams({ onglet: "assistant", mail: status, ...(message ? { message } : {}) });
      res.redirect(302, `/?${qs}`);
    };
    if (!automation.gmail) return back("error", "Connexion Gmail non configurée sur le serveur.");
    if (req.query.error) return back("error", "Connexion annulée.");
    try {
      await automation.gmail.handleCallback(String(req.query.code || ""), String(req.query.state || ""));
      back("connected");
    } catch (e: any) {
      back("error", e instanceof MailAuthError ? e.message : "Connexion Gmail impossible. Réessayez.");
    }
  });

  router.use((req: any, res, next) => {
    if (!req.uid && opts.authMode === "off" && !opts.production) req.uid = String(req.headers["x-dev-uid"] || "local-dev").slice(0, 128);
    if (!req.uid) return res.status(401).json({ success: false, error: "Connexion requise : connectez-vous pour utiliser l'agent de candidature." });
    next();
  });


  router.get("/status", wrap(async (req, res) => {
    const waiting = await store.queue.listWaiting(req.uid);
    res.json({ success: true, config: automation.config, channels: automation.channels.map((c) => ({ id: c.id, label: c.label })), waiting: waiting.length });
  }));

  router.get("/settings", wrap(async (req, res) => {
    res.json({ success: true, settings: await store.getSettings(req.uid) });
  }));

  router.put("/settings", wrap(async (req, res) => {
    const settings = sanitizeSettings(req.body, await store.getSettings(req.uid));
    await store.saveSettings(req.uid, settings);
    res.json({ success: true, settings });
  }));

  // Candidature demandée par l'utilisateur pour une offre
  router.post("/applications", wrap(async (req, res) => {
    const job = req.body?.job;
    if (!job || typeof job !== "object" || !String(job.title || "").trim() || !String(job.company || "").trim()) {
      return res.status(400).json({ success: false, error: "Offre invalide : intitulé et entreprise requis." });
    }
    const candidate = req.body?.candidate && typeof req.body.candidate === "object" ? req.body.candidate : undefined;
    const { task, created } = await store.queue.enqueue({
      uid: req.uid,
      type: "apply",
      dedupeKey: jobKey(job),
      payload: { job, candidate, origin: "user" }
    });
    res.status(created ? 201 : 200).json({ success: true, created, task: taskView(task) });
  }));

  router.get("/tasks", wrap(async (req, res) => {
    const status = String(req.query.status || "");
    const tasks = status === "waiting_user" ? await store.queue.listWaiting(req.uid) : await store.queue.listByUser(req.uid, Math.min(200, Number(req.query.limit) || 50));
    res.json({ success: true, tasks: tasks.map(taskView) });
  }));

  router.get("/tasks/:id", wrap(async (req, res) => {
    const task = await store.queue.get(req.params.id);
    if (!task || task.uid !== req.uid) return res.status(404).json({ success: false, error: "Candidature introuvable" });
    res.json({ success: true, task: taskView(task) });
  }));

  router.post("/tasks/:id/resolve", wrap(async (req, res) => {
    const b = req.body || {};
    if (!["approve", "reject", "answer", "code", "done"].includes(b.action)) {
      return res.status(400).json({ success: false, error: "Action inconnue." });
    }
    if (b.action === "code" && !String(b.code || "").trim()) return res.status(400).json({ success: false, error: "Code manquant." });
    const answers = b.answers && typeof b.answers === "object"
      ? Object.fromEntries(Object.entries(b.answers).map(([k, v]) => [String(k), String(v ?? "").slice(0, 5000)]))
      : undefined;
    const task = await orchestrator.resolve(req.uid, req.params.id, {
      action: b.action,
      answers,
      code: b.code,
      coverLetter: typeof b.coverLetter === "string" ? b.coverLetter.slice(0, 20_000) : undefined,
      remember: b.remember !== false
    });
    res.json({ success: true, task: taskView(task) });
  }));

  router.post("/tasks/:id/cancel", wrap(async (req, res) => {
    const task = await store.queue.get(req.params.id);
    if (!task || task.uid !== req.uid) return res.status(404).json({ success: false, error: "Candidature introuvable" });
    res.json({ success: true, task: taskView(await store.queue.cancel(task.id, "par l'utilisateur")) });
  }));

  // Offres trouvées pour l'utilisateur (sites d'emploi, pages carrière, publications)
  router.get("/offers", wrap(async (req, res) => {
    const discovery = await automation.discovery.ensureScheduled(req.uid);
    const status = String(req.query.status || "");
    const minScore = Number(req.query.minScore);
    let offers = await store.listOffers(req.uid, 500);
    offers = offers.filter((o) => (status ? o.status === status : o.status !== "dismissed"));
    if (Number.isFinite(minScore) && minScore > 0) offers = offers.filter((o) => (o.score ?? -1) >= minScore);
    // Meilleure compatibilité d'abord (offres sans compétences listées à la fin), puis les plus récentes
    offers.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || String(b.job?.publishedAt || "").localeCompare(String(a.job?.publishedAt || "")));
    res.json({ success: true, discovery, total: offers.length, offers: offers.slice(0, Math.min(300, Number(req.query.limit) || 100)) });
  }));

  router.post("/offers/:id/apply", wrap(async (req, res) => {
    const offer = await store.getOffer(req.uid, req.params.id);
    if (!offer) return res.status(404).json({ success: false, error: "Offre introuvable" });
    const candidate = req.body?.candidate && typeof req.body.candidate === "object" ? req.body.candidate : undefined;
    const { task, created } = await store.queue.enqueue({ uid: req.uid, type: "apply", dedupeKey: jobKey(offer.job), payload: { job: offer.job, candidate, origin: "user" } });
    await store.updateOffer(req.uid, offer.id, { status: "queued", taskId: task.id });
    res.status(created ? 201 : 200).json({ success: true, created, task: taskView(task) });
  }));

  router.post("/offers/:id/dismiss", wrap(async (req, res) => {
    const offer = await store.getOffer(req.uid, req.params.id);
    if (!offer) return res.status(404).json({ success: false, error: "Offre introuvable" });
    await store.updateOffer(req.uid, offer.id, { status: "dismissed" });
    res.json({ success: true });
  }));

  router.get("/discovery", wrap(async (req, res) => {
    res.json({ success: true, discovery: await automation.discovery.ensureScheduled(req.uid) });
  }));

  router.put("/discovery", wrap(async (req, res) => {
    const current = await automation.discovery.ensureScheduled(req.uid);
    const hours = Math.round(Number(req.body?.intervalHours));
    const next = {
      ...current,
      enabled: typeof req.body?.enabled === "boolean" ? req.body.enabled : current.enabled,
      intervalHours: Number.isFinite(hours) ? Math.min(48, Math.max(2, hours)) : current.intervalHours
    };
    await store.saveDiscovery(req.uid, next);
    res.json({ success: true, discovery: next });
  }));

  // Lancer la découverte tout de suite (au plus une fois toutes les 10 minutes)
  router.post("/discovery/run", wrap(async (req, res) => {
    if (!(await store.acquireNotificationSlot(req.uid, "discovery_manual", 10 * 60_000))) {
      return res.status(429).json({ success: false, error: "Recherche déjà lancée il y a moins de 10 minutes." });
    }
    const candidate = req.body?.candidate && typeof req.body.candidate === "object" ? req.body.candidate : undefined;
    res.json({ success: true, run: await automation.runDiscovery(req.uid, candidate) });
  }));

  // Boîte mail de l'utilisateur
  router.get("/mail", wrap(async (req, res) => {
    const google = await store.getMailConnection(req.uid, "google");
    res.json({
      success: true,
      gmailAvailable: !!automation.gmail,
      google: google ? { email: google.email, status: google.status, connectedAt: google.connectedAt } : null
    });
  }));

  router.get("/mail/google/connect", wrap(async (req, res) => {
    if (!automation.gmail) return res.status(503).json({ success: false, error: "Connexion Gmail non configurée sur le serveur." });
    res.json({ success: true, url: automation.gmail.authorizationUrl(req.uid) });
  }));

  router.delete("/mail/google", wrap(async (req, res) => {
    if (automation.gmail) await automation.gmail.disconnect(req.uid);
    else await store.deleteMailConnection(req.uid, "google");
    res.json({ success: true });
  }));

  // Base de réponses
  router.get("/answers", wrap(async (req, res) => {
    res.json({ success: true, answers: await store.listAnswers(req.uid) });
  }));

  router.put("/answers", wrap(async (req, res) => {
    const label = String(req.body?.label || "").trim().slice(0, 500);
    const answer = String(req.body?.answer ?? "").trim().slice(0, 5000);
    if (!label || !answer) return res.status(400).json({ success: false, error: "Question et réponse requises." });
    const saved = { key: questionKey(label), label, category: categorize(label), answer, updatedAt: new Date().toISOString() };
    await store.saveAnswer(req.uid, saved);
    res.json({ success: true, answer: saved });
  }));

  router.delete("/answers/:key", wrap(async (req, res) => {
    await store.deleteAnswer(req.uid, req.params.key);
    res.json({ success: true });
  }));

  // Coffre des identifiants
  router.get("/vault", wrap(async (req, res) => {
    res.json({ success: true, enabled: vault.enabled, entries: await vault.list(req.uid) });
  }));

  // POST (et non GET) : le mot de passe ne doit apparaître ni dans les journaux d'URL ni dans un cache
  router.post("/vault/:id/reveal", wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, password: await vault.reveal(req.uid, req.params.id) });
  }));

  router.delete("/vault/:id", wrap(async (req, res) => {
    await vault.remove(req.uid, req.params.id);
    res.json({ success: true });
  }));

  // Appareils pour les notifications (jeton Firebase Cloud Messaging)
  router.post("/devices", wrap(async (req, res) => {
    const token = String(req.body?.token || "").trim();
    if (!token || token.length > 4096) return res.status(400).json({ success: false, error: "Jeton invalide." });
    await store.saveDeviceToken(req.uid, token);
    res.json({ success: true });
  }));

  router.delete("/devices", wrap(async (req, res) => {
    await store.deleteDeviceToken(req.uid, String(req.body?.token || ""));
    res.json({ success: true });
  }));

  return router;
}
