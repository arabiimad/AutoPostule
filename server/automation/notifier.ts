/**
 * Notifications sur le téléphone de l'utilisateur quand l'agent a besoin de lui.
 *
 * Regroupées : au plus une notification « N candidatures attendent un tap » par période
 * (NOTIFY_DIGEST_HOURS, 12 h par défaut). Exception : un code de vérification expire vite,
 * il est signalé tout de suite.
 */
import type { AutomationStore } from "./store.ts";
import type { PendingKind } from "./types.ts";

export interface PushMessage {
  title: string;
  body: string;
  /** Lien ouvert au clic (page des candidatures en attente). */
  link: string;
  data?: Record<string, string>;
}

export interface PushSender {
  readonly kind: string;
  send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }>;
}

/** Garde les notifications en mémoire (tests, développement). */
export class MemoryPushSender implements PushSender {
  readonly kind = "memory";
  sent: { tokens: string[]; message: PushMessage }[] = [];
  async send(tokens: string[], message: PushMessage) {
    this.sent.push({ tokens, message });
    return { invalidTokens: [] };
  }
}

/** Firebase Cloud Messaging (compte de service ou identifiants Cloud Run). */
export class FcmPushSender implements PushSender {
  readonly kind = "fcm";
  async send(tokens: string[], message: PushMessage) {
    if (!tokens.length) return { invalidTokens: [] };
    const { getMessaging } = await import("firebase-admin/messaging");
    const { adminApp } = await import("./firebaseAdmin.ts");
    const res = await getMessaging(await adminApp()).sendEachForMulticast({
      tokens,
      notification: { title: message.title, body: message.body },
      data: { link: message.link, ...message.data },
      webpush: { fcmOptions: { link: message.link } }
    });
    const invalidTokens = res.responses
      .map((r, i) => (!r.success && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(r.error?.code || "") ? tokens[i] : null))
      .filter((t): t is string => !!t);
    return { invalidTokens };
  }
}

export class Notifier {
  constructor(
    private store: AutomationStore,
    private sender: PushSender,
    private opts: { appUrl: string; digestHours: number }
  ) {}

  get kind() {
    return this.sender.kind;
  }

  /** Appelée à chaque mise en attente d'une candidature. */
  async onWaiting(uid: string, kind: PendingKind): Promise<boolean> {
    const urgent = kind === "verification_code";
    const windowMs = urgent ? 60_000 : this.opts.digestHours * 3_600_000;
    if (!(await this.store.acquireNotificationSlot(uid, urgent ? "urgent" : "digest", windowMs))) return false;

    const tokens = await this.store.listDeviceTokens(uid);
    if (!tokens.length) return false;
    const waiting = (await this.store.queue.listWaiting(uid)).length;
    const link = `${this.opts.appUrl.replace(/\/$/, "")}/?onglet=assistant`;
    const message: PushMessage = urgent
      ? { title: "Code de vérification demandé", body: "Un site demande un code : ouvrez AutoPostule pour le saisir avant qu'il expire.", link, data: { kind } }
      : {
          title: waiting > 1 ? `${waiting} candidatures attendent un tap` : "Une candidature attend un tap",
          body: "Tout est prêt : il ne reste qu'à valider depuis votre téléphone.",
          link,
          data: { kind, waiting: String(waiting) }
        };
    try {
      const { invalidTokens } = await this.sender.send(tokens, message);
      for (const t of invalidTokens) await this.store.deleteDeviceToken(uid, t);
      return true;
    } catch (e: any) {
      console.warn("[Notifications] envoi impossible :", e?.message || e);
      return false;
    }
  }
}
