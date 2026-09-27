/**
 * Assemblage de l'agent à partir des variables d'environnement.
 *
 *   AUTOMATION_STORE      memory (défaut) | firestore
 *   AUTOMATION_WORKER     inline (défaut avec memory) | off (défaut avec firestore : Cloud Scheduler appelle /api/automation/tick)
 *   AUTOMATION_CRON_SECRET  secret attendu dans l'en-tête x-automation-secret de /api/automation/tick
 *   AUTOMATION_MAIL       simulated (défaut hors production) | off
 *   AUTOMATION_PUSH       fcm (défaut avec firestore) | memory | off
 *   VAULT_KEY             clé du coffre (openssl rand -base64 32) ; VAULT_KEYS_OLD pour la rotation
 *   APP_URL               adresse publique de l'application (liens des notifications)
 *   NOTIFY_DIGEST_HOURS   une notification groupée au plus toutes les N heures (12 par défaut)
 */
import { EmailChannel, ManualChannel, SimulatedMailSender, type ApplyChannel, type MailSender } from "./channels.ts";
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
  config: { store: string; worker: "inline" | "off"; mail: string; push: string; vault: boolean; cronSecret: boolean };
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

  const mailMode = env.AUTOMATION_MAIL || (production ? "off" : "simulated");
  // Boîtes simulées, une par utilisateur : les connexions Gmail / Outlook (OAuth) viendront ici
  const simulated = new Map<string, SimulatedMailSender>();
  const mailFor =
    opts.mailFor ||
    (async (uid: string) => {
      if (mailMode !== "simulated") return null;
      if (!simulated.has(uid)) {
        const profile = await store!.getProfile(uid).catch(() => null);
        simulated.set(uid, new SimulatedMailSender(profile?.email || `${uid}@simulation.local`));
      }
      return simulated.get(uid)!;
    });

  const vault = new Vault(store, cipherFromEnv(env, production));
  const notifier = new Notifier(store, pushSender, {
    appUrl: env.APP_URL || `http://localhost:${env.PORT || 3000}`,
    digestHours: Number(env.NOTIFY_DIGEST_HOURS) || 12
  });
  const channels: ApplyChannel[] = [new EmailChannel(mailFor), new ManualChannel()];
  const orchestrator = new Orchestrator({ store, vault, notifier, channels, prepare: opts.prepare, ai: opts.ai, log: opts.log });

  const worker = (env.AUTOMATION_WORKER || (store.kind === "memory" ? "inline" : "off")) === "inline" ? "inline" : "off";
  let timer: ReturnType<typeof setInterval> | null = null;
  if (worker === "inline") {
    let running = false;
    timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await orchestrator.tick({ workerId: "inline" });
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
    config: { store: store.kind, worker, mail: mailMode, push: pushSender.kind, vault: vault.enabled, cronSecret: !!env.AUTOMATION_CRON_SECRET },
    stop: () => {
      if (timer) clearInterval(timer);
    }
  };
}
