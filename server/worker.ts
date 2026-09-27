/**
 * Worker d'auto-candidature (processus permanent, séparé du serveur web).
 *   npm run worker            (développement)
 *   node build/server/worker.cjs  (production, ex. Render « Background Worker »)
 *
 * Variables : AUTOMATION_DATABASE_URL (obligatoire), AUTOMATION_TOKEN_KEY (jetons de messagerie),
 * GEMINI_API_KEY, clés des sources d'offres, GOOGLE_CLIENT_ID/SECRET, MICROSOFT_CLIENT_ID/SECRET.
 * Réglages : AUTOMATION_POLL_SECONDS (défaut 15), AUTOMATION_SEARCH_EVERY_HOURS (défaut 12 : deux recherches par jour),
 * AUTOMATION_CONCURRENCY (défaut 1 envoi à la fois).
 * Collecte des offres France Travail (base d'offres, migration 007) : INGEST_FT=on,
 * INGEST_FT_EVERY_MINUTES (défaut 60, nouveautés), INGEST_FT_FULL_EVERY_HOURS (défaut 24, balayage complet),
 * FT_SYNC_RPS (appels par seconde, défaut 3).
 */
import dotenv from "dotenv";
import os from "node:os";
import { PgAutomationStore } from "./automation/pgStore.ts";
import { realDeps, closeFormBrowser } from "./automation/runtime.ts";
import { runOnce } from "./automation/worker.ts";
import { closeWebPdf } from "./pdf.ts";
import { logEvent } from "./log.ts";
import { captureError, initMonitoring } from "./monitoring.ts";
import { PgOfferStore } from "./ingest/offerStore.ts";
import { syncFranceTravail } from "./ingest/franceTravail.ts";
import { enableOfferIndexFromEnv } from "./ingest/offerSearch.ts";

dotenv.config();

const store = PgAutomationStore.fromEnv();
if (!store) {
  console.error("AUTOMATION_DATABASE_URL manquante : le worker d'auto-candidature ne peut pas démarrer.");
  process.exit(1);
}
if (!process.env.AUTOMATION_TOKEN_KEY) {
  console.error("AUTOMATION_TOKEN_KEY manquante : les jetons de messagerie ne peuvent pas être déchiffrés.");
  process.exit(1);
}

const workerId = `${os.hostname()}-${process.pid}`;
const pollMs = Math.max(5, Number(process.env.AUTOMATION_POLL_SECONDS) || 15) * 1000;
const searchEveryHours = Math.max(1, Number(process.env.AUTOMATION_SEARCH_EVERY_HOURS) || 12);
const concurrency = Math.max(1, Math.min(4, Number(process.env.AUTOMATION_CONCURRENCY) || 1));
const deps = realDeps(store, workerId);

let stopping = false;

// Collecte continue des offres (en arrière-plan : ne ralentit jamais les envois)
const ingestEnabled = process.env.INGEST_FT === "on" && !!process.env.FT_CLIENT_ID && !!process.env.FT_CLIENT_SECRET;
const offerStore = ingestEnabled ? new PgOfferStore(store.pool) : null;
const ingestEveryMs = Math.max(15, Number(process.env.INGEST_FT_EVERY_MINUTES) || 60) * 60_000;
const fullEveryMs = Math.max(6, Number(process.env.INGEST_FT_FULL_EVERY_HOURS) || 24) * 3600_000;
let ingesting = false;
let lastIngest = 0;
let lastFullIngest = 0;

function maybeIngest() {
  if (!offerStore || ingesting || stopping || Date.now() - lastIngest < ingestEveryMs) return;
  ingesting = true;
  lastIngest = Date.now();
  const mode = Date.now() - lastFullIngest >= fullEveryMs ? "full" : "incremental";
  // Verrou PostgreSQL : un seul worker collecte, même à plusieurs instances
  offerStore
    .withLock("ingest:france-travail", () => syncFranceTravail(offerStore, {
      mode,
      rps: Number(process.env.FT_SYNC_RPS) || undefined,
      log: (event, data) => { if (event.endsWith("error")) logEvent("warn", event, data); }
    }))
    .then((summary) => {
      if (!summary) return;
      if (mode === "full") lastFullIngest = Date.now();
      const { errors, ...rest } = summary;
      logEvent(errors.length ? "warn" : "info", "ingest_france_travail", { ...rest, errors: errors.length, firstError: errors[0]?.message });
    })
    .catch((e) => logEvent("error", "ingest_france_travail_failed", { message: String(e?.message || e).slice(0, 300) }))
    .finally(() => { ingesting = false; });
}
let lastMaintenance = 0;
let lastPurge = 0;

async function tick() {
  if (Date.now() - lastMaintenance > 5 * 60_000) {
    lastMaintenance = Date.now();
    const [scheduled, swept, tracking] = await Promise.all([
      store!.scheduleSearches(searchEveryHours),
      store!.sweepInterruptedSubmissions(),
      store!.scheduleReplyTracking(3)
    ]);
    if (scheduled || swept || tracking) logEvent("info", "automation_maintenance", { scheduled, swept, tracking });
    // Alerte : traitements bloqués (bail expiré) ou en retard → journal d'erreur (Sentry si configuré)
    const sup = await store!.supervision();
    if (sup.tasks?.stuck || sup.tasks?.late > 10) {
      logEvent("error", "automation_backlog", { stuck: sup.tasks.stuck, late: sup.tasks.late });
      captureError(new Error(`Auto-candidature : ${sup.tasks.stuck} traitement(s) bloqué(s), ${sup.tasks.late} en retard`), { stuck: sup.tasks.stuck, late: sup.tasks.late });
    }
  }
  // Conservation des preuves : une fois par jour
  if (Date.now() - lastPurge > 24 * 3600_000) {
    lastPurge = Date.now();
    const purged = await store!.purgeOld(Number(process.env.AUTOMATION_PROOF_DAYS) || 180);
    logEvent("info", "automation_purge", purged);
  }
  maybeIngest();
  // Traite tant qu'il y a du travail, puis attend
  while (!stopping && (await runOnce(deps, { limit: concurrency, leaseSeconds: 600 })) > 0) { /* lot suivant */ }
}

async function loop() {
  await initMonitoring().catch(() => {});
  // Recherches planifiées de l'agent : partie France Travail lue dans la base d'offres (JOBS_INDEX=on)
  await enableOfferIndexFromEnv().catch(() => false);
  logEvent("info", "automation_worker_started", { workerId, pollMs, searchEveryHours, concurrency });
  while (!stopping) {
    try {
      await tick();
    } catch (e: any) {
      logEvent("error", "automation_worker_error", { message: String(e?.message || e).slice(0, 300) });
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    stopping = true;
    logEvent("info", "automation_worker_stopping", { workerId, signal });
    // Les tâches en cours gardent leur bail : si l'arrêt interrompt un envoi, il sera marqué « incertain », jamais renvoyé
    await Promise.allSettled([closeWebPdf(), closeFormBrowser(), store!.close()]);
    process.exit(0);
  });
}

loop();
