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
    res.json({ success: true, ...(await orchestrator.tick({ limit })) });
  }));

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
