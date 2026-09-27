/**
 * Worker d'auto-candidature (processus permanent, séparé du serveur web).
 *   npm run worker            (développement)
 *   node build/server/worker.cjs  (production, ex. Render « Background Worker »)
 *
 * Variables : AUTOMATION_DATABASE_URL (obligatoire), AUTOMATION_TOKEN_KEY (jetons de messagerie),
 * GEMINI_API_KEY, clés des sources d'offres, GOOGLE_CLIENT_ID/SECRET, MICROSOFT_CLIENT_ID/SECRET.
 * Réglages : AUTOMATION_POLL_SECONDS (défaut 15), AUTOMATION_SEARCH_EVERY_HOURS (défaut 12 : deux recherches par jour),
 * AUTOMATION_CONCURRENCY (défaut 1 envoi à la fois).
 */
import dotenv from "dotenv";
import os from "node:os";
import { PgAutomationStore } from "./automation/pgStore.ts";
import { realDeps, closeFormBrowser } from "./automation/runtime.ts";
import { runOnce } from "./automation/worker.ts";
import { closeWebPdf } from "./pdf.ts";
import { logEvent } from "./log.ts";

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
let lastMaintenance = 0;

async function tick() {
  if (Date.now() - lastMaintenance > 5 * 60_000) {
    lastMaintenance = Date.now();
    const [scheduled, swept, tracking] = await Promise.all([
      store!.scheduleSearches(searchEveryHours),
      store!.sweepInterruptedSubmissions(),
      store!.scheduleReplyTracking(3)
    ]);
    if (scheduled || swept || tracking) logEvent("info", "automation_maintenance", { scheduled, swept, tracking });
  }
  // Traite tant qu'il y a du travail, puis attend
  while (!stopping && (await runOnce(deps, { limit: concurrency, leaseSeconds: 600 })) > 0) { /* lot suivant */ }
}

async function loop() {
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
