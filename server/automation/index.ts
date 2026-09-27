/**
 * Assemblage de l'agent à partir des variables d'environnement.
 *
 *   AUTOMATION_STORE      memory (défaut) | firestore
 *   AUTOMATION_WORKER     inline (défaut avec memory) | off (défaut avec firestore : Cloud Scheduler appelle /api/automation/tick)
 *   AUTOMATION_CRON_SECRET  secret attendu dans l'en-tête x-automation-secret de /api/automation/tick
 *   AUTOMATION_MAIL       simulated (défaut hors production) | off : boîte utilisée quand l'utilisateur n'a pas connecté Gmail
 *   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET  envoi depuis la boîte Gmail de l'utilisateur (OAuth, gmail.send)
 *   LBA_API_KEY           envoi par l'API de La bonne alternance (habilitation applications:write)
 *   DISCOVERY_USERS_PER_TICK  découvertes d'offres lancées à chaque passage (3 par défaut)
 *   AUTOMATION_PUSH       fcm (défaut avec firestore) | memory | off
 *   VAULT_KEY             clé du coffre (openssl rand -base64 32) ; VAULT_KEYS_OLD pour la rotation
 *   APP_URL               adresse publique de l'application (liens des notifications)
 *   NOTIFY_DIGEST_HOURS   une notification groupée au plus toutes les N heures (12 par défaut)
 */
import { createHash, randomBytes } from "node:crypto";
import { EmailChannel, LbaChannel, ManualChannel, SimulatedMailSender, type ApplyChannel, type MailSender } from "./channels.ts";
import { GoogleMail } from "./gmail.ts";
import { jobKey } from "./guardrails.ts";
import { DiscoveryService, type DiscoveryDeps, type DiscoveryRun } from "../discovery/discover.ts";
import { FcmPushSender, MemoryPushSender, Notifier, type PushSender } from "./notifier.ts";
import { Orchestrator, type DocumentPreparer } from "./orchestrator.ts";
import { MemoryAutomationStore, type AutomationStore } from "./store.ts";
import { Vault, cipherFromEnv } from "./vault.ts";
import type { AiAnswerFn } from "./answers.ts";

export interface Automation {
  store: AutomationStore;
  vault: Vault;
  notifier: Notifier;
  orchestrator: Orchestrator;
  channels: ApplyChannel[];
  discovery: DiscoveryService;
  /** Gmail (OAuth), si configuré. */
  gmail: GoogleMail | null;
  config: { store: string; worker: "inline" | "off"; mail: string; gmail: boolean; lba: boolean; push: string; vault: boolean; cronSecret: boolean; webSearch: boolean };
  /** Découverte pour un utilisateur, suivie de la mise en file automatique si elle est activée. */
  runDiscovery(uid: string, profile?: any): Promise<DiscoveryRun>;
  /** Un passage complet : candidatures prêtes puis découvertes dues. */
  tick(opts?: { limit?: number }): Promise<{ processed: { id: string; status: string }[]; discoveries: string[] }>;
  stop(): void;
}

export async function createAutomation(opts: {
  prepare: DocumentPreparer;
  ai?: AiAnswerFn | null;
  log?: (level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>) => void;
  env?: NodeJS.ProcessEnv;
  store?: AutomationStore;
  pushSender?: PushSender;
  mailFor?: (uid: string) => Promise<MailSender | null>;
  discovery?: Omit<DiscoveryDeps, "store" | "log">;
  lbaFetch?: ConstructorParameters<typeof LbaChannel>[0]["fetch"];
}): Promise<Automation> {
  const env = opts.env || process.env;
  const production = env.NODE_ENV === "production";

  let store = opts.store;
  if (!store) {
    if (env.AUTOMATION_STORE === "firestore") {
      const { FirestoreAutomationStore } = await import("./firestoreStore.ts");
      store = await FirestoreAutomationStore.create();
    } else {
      if (production) opts.log?.("warn", "automation_memory_store", { message: "AUTOMATION_STORE=firestore conseillé en production : la file en mémoire est perdue au redémarrage." });
      store = new MemoryAutomationStore();
    }
  }

  const pushMode = env.AUTOMATION_PUSH || (store.kind === "firestore" ? "fcm" : "memory");
  const pushSender: PushSender =
    opts.pushSender ||
    (pushMode === "fcm" ? new FcmPushSender() : pushMode === "off" ? { kind: "off", send: async () => ({ invalidTokens: [] }) } : new MemoryPushSender());

  const cipher = cipherFromEnv(env, production);
  const vault = new Vault(store, cipher);

  // Gmail : jeton OAuth chiffré avec la clé du coffre (désactivé si le coffre l'est)
  const appUrl = (env.APP_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, "");
  const gmail = env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && cipher
    ? new GoogleMail({
        clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        redirectUri: `${appUrl}/api/automation/mail/google/callback`,
        stateSecret: env.OAUTH_STATE_SECRET || (env.VAULT_KEY ? createHash("sha256").update(`oauth-state|${env.VAULT_KEY}`).digest("hex") : randomBytes(32).toString("hex"))
      }, store, cipher)
    : null;

  const mailMode = env.AUTOMATION_MAIL || (production ? "off" : "simulated");
  const simulated = new Map<string, SimulatedMailSender>();
  const mailFor =
    opts.mailFor ||
    (async (uid: string) => {
      const real = gmail ? await gmail.senderFor(uid) : null;
      if (real) return real;
      if (mailMode !== "simulated") return null;
      // Développement : boîte simulée, rien ne part réellement
      if (!simulated.has(uid)) {
        const profile = await store!.getProfile(uid).catch(() => null);
        simulated.set(uid, new SimulatedMailSender(profile?.email || `${uid}@simulation.local`));
      }
      return simulated.get(uid)!;
    });
  const notifier = new Notifier(store, pushSender, {
    appUrl,
    digestHours: Number(env.NOTIFY_DIGEST_HOURS) || 12
  });
  // Ordre de préférence : API officielle, email au recruteur, puis étape manuelle
  const channels: ApplyChannel[] = [
    new LbaChannel({ apiKey: env.LBA_API_KEY, baseUrl: env.LBA_API_BASE, fetch: opts.lbaFetch }),
    new EmailChannel(mailFor),
    new ManualChannel()
  ];
  const orchestrator = new Orchestrator({ store, vault, notifier, channels, prepare: opts.prepare, ai: opts.ai, log: opts.log });

  const discovery = new DiscoveryService({ ...opts.discovery, store, log: opts.log });

  const runDiscovery = async (uid: string, profile?: any): Promise<DiscoveryRun> => {
    const settings = await store!.getSettings(uid);
    const state = await discovery.ensureScheduled(uid);
    try {
      const result = await discovery.run(uid, profile, {
        minScore: settings.minMatchScore,
        maxQueued: settings.paused ? 0 : settings.dailyCap,
        enqueue: async (u, job) => {
          const { task, created } = await store!.queue.enqueue({ uid: u, type: "apply", dedupeKey: jobKey(job), payload: { job, origin: "agent" } });
          return created ? task.id : null;
        }
      });
      const at = new Date();
      await store!.saveDiscovery(uid, {
        ...state,
        lastRunAt: at.toISOString(),
        nextRunAt: new Date(at.getTime() + state.intervalHours * 3_600_000).toISOString(),
        lastStats: { ...result },
        lastError: undefined
      });
      return result;
    } catch (e: any) {
      // Nouvel essai dans une heure
      await store!.saveDiscovery(uid, { ...state, lastError: String(e?.message || e), nextRunAt: new Date(Date.now() + 3_600_000).toISOString() });
      throw e;
    }
  };

  const tick = async (o: { limit?: number } = {}) => {
    const { processed } = await orchestrator.tick({ limit: o.limit });
    const due = await store!.claimDueDiscoveries(Number(env.DISCOVERY_USERS_PER_TICK) || 3, 30 * 60_000);
    for (const uid of due) {
      try {
        await runDiscovery(uid);
      } catch (e: any) {
        opts.log?.("warn", "discovery_failed", { uid, message: String(e?.message || e) });
      }
    }
    return { processed, discoveries: due };
  };

  const worker = (env.AUTOMATION_WORKER || (store.kind === "memory" ? "inline" : "off")) === "inline" ? "inline" : "off";
  let timer: ReturnType<typeof setInterval> | null = null;
  if (worker === "inline") {
    let running = false;
    timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await tick();
      } catch (e: any) {
        opts.log?.("error", "automation_tick_failed", { message: String(e?.message || e) });
      } finally {
        running = false;
      }
    }, Number(env.AUTOMATION_TICK_MS) || 15_000);
    (timer as any).unref?.();
  }

  return {
    store,
    vault,
    notifier,
    orchestrator,
    channels,
    discovery,
    gmail,
    runDiscovery,
    tick,
    config: {
      store: store.kind,
      worker,
      mail: mailMode,
      gmail: !!gmail,
      lba: !!env.LBA_API_KEY,
      push: pushSender.kind,
      vault: vault.enabled,
      cronSecret: !!env.AUTOMATION_CRON_SECRET,
      webSearch: !!opts.discovery?.webSearch
    },
    stop: () => {
      if (timer) clearInterval(timer);
    }
  };
}
