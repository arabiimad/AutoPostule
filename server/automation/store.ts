/**
 * Stockage de l'agent : file de tâches + données par utilisateur (réglages, réponses, coffre, envois).
 *
 * - MemoryAutomationStore : développement et tests (perdu au redémarrage).
 * - FirestoreAutomationStore (firestoreStore.ts) : production, partagé entre instances Cloud Run.
 *
 * File de tâches à « bail » : un worker réserve une tâche pour une durée limitée (leaseUntil).
 * S'il plante, le bail expire et un autre worker la reprend ; les tentatives sont comptées.
 */
import { randomUUID } from "node:crypto";
import type {
  AutomationSettings, NewTask, PendingAction, Resolution, SavedAnswer, Submission, SubmissionResult, Task, VaultEntry
} from "./types.ts";

export interface TaskQueue {
  /** Ajoute une tâche ; si une tâche active a déjà la même dedupeKey, la renvoie (created = false). */
  enqueue(task: NewTask): Promise<{ task: Task; created: boolean }>;
  /** Réserve jusqu'à `limit` tâches prêtes (ou dont le bail a expiré). */
  claim(workerId: string, limit: number, leaseMs: number): Promise<Task[]>;
  get(id: string): Promise<Task | null>;
  listByUser(uid: string, limit?: number): Promise<Task[]>;
  listWaiting(uid: string): Promise<Task[]>;
  /** Enregistre des changements sur une tâche réservée par ce worker (sans libérer le bail). */
  update(id: string, workerId: string, patch: Partial<Pick<Task, "payload">>, event?: string): Promise<Task>;
  complete(id: string, workerId: string, result: SubmissionResult, event: string): Promise<Task>;
  /** Échec : nouvelle tentative après `retryInMs`, ou échec définitif si retryInMs est null / tentatives épuisées. */
  fail(id: string, workerId: string, error: string, retryInMs: number | null): Promise<Task>;
  /** Repousse sans compter de tentative (plafond quotidien atteint…). */
  reschedule(id: string, workerId: string, runAt: string, event: string): Promise<Task>;
  pause(id: string, workerId: string, pending: PendingAction): Promise<Task>;
  cancel(id: string, reason: string, workerId?: string): Promise<Task>;
  /** Réponse de l'utilisateur à une tâche en attente : fusionne la résolution et remet la tâche en file. */
  resume(id: string, uid: string, resolution: Resolution): Promise<Task>;
}

/** Boîte mail connectée (jeton de rafraîchissement OAuth chiffré). */
export interface MailConnection {
  provider: "google" | "microsoft";
  email: string;
  secret: string;
  status: "active" | "revoked";
  connectedAt: string;
  updatedAt: string;
}

/** Offre trouvée par la découverte automatique, listée à l'utilisateur. */
export interface DiscoveredOffer {
  /** sha1 de l'offre (entreprise + intitulé + lieu) : la même offre vue sur plusieurs sources reste unique. */
  id: string;
  job: any;
  /** Compatibilité avec le profil (0-100), null si l'offre ne cite aucune compétence. */
  score: number | null;
  matchedKeywords: string[];
  missingKeywords: string[];
  status: "new" | "seen" | "queued" | "dismissed";
  taskId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface DiscoveryState {
  enabled: boolean;
  intervalHours: number;
  nextRunAt: string;
  lastRunAt?: string;
  lastStats?: Record<string, unknown>;
  lastError?: string;
}

export interface KnownBoard {
  id: string;
  ats: string;
  token: string;
  region?: string;
  lastSeenAt: string;
}

export interface AutomationStore {
  readonly kind: "memory" | "firestore";
  queue: TaskQueue;
  getSettings(uid: string): Promise<AutomationSettings>;
  saveSettings(uid: string, settings: AutomationSettings): Promise<void>;
  /** Profil de l'utilisateur (users/{uid} dans Firestore). */
  getProfile(uid: string): Promise<any | null>;
  listAnswers(uid: string): Promise<SavedAnswer[]>;
  saveAnswer(uid: string, answer: SavedAnswer): Promise<void>;
  deleteAnswer(uid: string, key: string): Promise<void>;
  listVault(uid: string): Promise<VaultEntry[]>;
  saveVault(uid: string, entry: VaultEntry): Promise<void>;
  deleteVault(uid: string, id: string): Promise<void>;
  recordSubmission(uid: string, submission: Submission): Promise<void>;
  listSubmissionsSince(uid: string, sinceIso: string): Promise<Submission[]>;
  listDeviceTokens(uid: string): Promise<string[]>;
  saveDeviceToken(uid: string, token: string): Promise<void>;
  deleteDeviceToken(uid: string, token: string): Promise<void>;
  getMailConnection(uid: string, provider: MailConnection["provider"]): Promise<MailConnection | null>;
  saveMailConnection(uid: string, conn: MailConnection): Promise<void>;
  deleteMailConnection(uid: string, provider: MailConnection["provider"]): Promise<void>;
  upsertOffers(uid: string, offers: DiscoveredOffer[]): Promise<{ added: number }>;
  listOffers(uid: string, limit?: number): Promise<DiscoveredOffer[]>;
  getOffer(uid: string, id: string): Promise<DiscoveredOffer | null>;
  updateOffer(uid: string, id: string, patch: Partial<Pick<DiscoveredOffer, "status" | "taskId">>): Promise<void>;
  getDiscovery(uid: string): Promise<DiscoveryState | null>;
  saveDiscovery(uid: string, state: DiscoveryState): Promise<void>;
  /** Réserve les utilisateurs dont la découverte est due (repousse leur prochain passage de leaseMs). */
  claimDueDiscoveries(limit: number, leaseMs: number): Promise<string[]>;
  saveBoards(boards: Omit<KnownBoard, "lastSeenAt">[]): Promise<void>;
  listBoards(limit: number): Promise<KnownBoard[]>;
  /** Anti-spam des notifications : renvoie true si la clé n'a pas été utilisée depuis `windowMs`. */
  acquireNotificationSlot(uid: string, key: string, windowMs: number): Promise<boolean>;
}

export const DEFAULT_SETTINGS: AutomationSettings = {
  level: "progressive",
  paused: false,
  minMatchScore: 60,
  dailyCap: 15,
  sameCompanyCooldownDays: 30,
  excludedCompanies: [],
  progressiveThreshold: 10,
  cleanApprovals: 0
};

export class TaskStateError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

export const ACTIVE_STATUSES = new Set(["queued", "running", "waiting_user"]);
const nowIso = () => new Date().toISOString();
const MAX_HISTORY = 50;

export function withEvent(task: Task, message: string, at = nowIso()): Task["history"] {
  return [...task.history, { at, message }].slice(-MAX_HISTORY);
}

export function newTask(input: NewTask, id: string = randomUUID()): Task {
  const at = nowIso();
  return {
    id,
    uid: input.uid,
    type: input.type,
    status: "queued",
    dedupeKey: input.dedupeKey,
    payload: input.payload,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 3,
    runAt: input.runAt || at,
    history: [{ at, message: "Candidature ajoutée à la file" }],
    createdAt: at,
    updatedAt: at
  };
}

/** Vérifie qu'une tâche est bien réservée par ce worker avant de la modifier. */
export function assertLease(task: Task | null | undefined, workerId: string): Task {
  if (!task) throw new TaskStateError("Tâche introuvable", 404);
  if (task.status !== "running" || task.lockedBy !== workerId) {
    throw new TaskStateError(`Tâche ${task.id} non réservée par ${workerId}`);
  }
  return task;
}

/**
 * Transitions pures (partagées par les deux stockages) : chacune renvoie la tâche mise à jour.
 */
export const transitions = {
  claim(task: Task, workerId: string, leaseMs: number, at = new Date()): Task {
    const expiredLease = task.status === "running";
    return {
      ...task,
      status: "running",
      lockedBy: workerId,
      leaseUntil: new Date(at.getTime() + leaseMs).toISOString(),
      // Un bail expiré compte comme une tentative (le worker précédent a planté)
      attempts: task.attempts + 1,
      history: expiredLease ? withEvent(task, "Reprise après interruption du traitement") : task.history,
      updatedAt: at.toISOString()
    };
  },
  release(task: Task, patch: Partial<Task>, event?: string): Task {
    return {
      ...task,
      ...patch,
      lockedBy: undefined,
      leaseUntil: undefined,
      history: event ? withEvent(task, event) : task.history,
      updatedAt: nowIso()
    };
  },
  fail(task: Task, error: string, retryInMs: number | null): Task {
    const final = retryInMs == null || task.attempts >= task.maxAttempts;
    return transitions.release(
      task,
      final
        ? { status: "failed", lastError: error }
        : { status: "queued", lastError: error, runAt: new Date(Date.now() + retryInMs!).toISOString() },
      final ? `Échec : ${error}` : `Erreur (nouvelle tentative prévue) : ${error}`
    );
  },
  resume(task: Task, uid: string, resolution: Resolution): Task {
    if (task.uid !== uid) throw new TaskStateError("Tâche introuvable", 404);
    if (task.status !== "waiting_user") throw new TaskStateError("Cette candidature n'attend pas de réponse");
    const merged: Resolution = {
      ...task.resolution,
      ...resolution,
      answers: { ...task.resolution?.answers, ...resolution.answers }
    };
    if (resolution.rejected) {
      return transitions.release(task, { status: "cancelled", pending: undefined, resolution: merged }, "Envoi refusé par l'utilisateur");
    }
    return transitions.release(
      task,
      // La reprise ne consomme pas de tentative : on redonne celle du traitement interrompu
      { status: "queued", pending: undefined, resolution: merged, runAt: nowIso(), attempts: Math.max(0, task.attempts - 1) },
      "Réponse reçue, reprise de la candidature"
    );
  }
};

export function isClaimable(task: Task, at: Date): boolean {
  if (task.status === "queued") return task.runAt <= at.toISOString();
  if (task.status === "running") return !!task.leaseUntil && task.leaseUntil <= at.toISOString();
  return false;
}

// ---------------------------------------------------------------------------
// Mémoire
// ---------------------------------------------------------------------------
class MemoryTaskQueue implements TaskQueue {
  private tasks = new Map<string, Task>();

  private put(task: Task) {
    this.tasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }

  private raw(id: string) {
    return this.tasks.get(id) || null;
  }

  async enqueue(input: NewTask) {
    for (const t of this.tasks.values()) {
      if (t.uid === input.uid && t.dedupeKey === input.dedupeKey && (ACTIVE_STATUSES.has(t.status) || t.status === "done")) {
        return { task: structuredClone(t), created: false };
      }
    }
    return { task: this.put(newTask(input)), created: true };
  }

  async claim(workerId: string, limit: number, leaseMs: number) {
    const at = new Date();
    const ready = [...this.tasks.values()].filter((t) => isClaimable(t, at)).sort((a, b) => a.runAt.localeCompare(b.runAt));
    const out: Task[] = [];
    for (const t of ready.slice(0, limit)) {
      if (t.status === "running" && t.attempts >= t.maxAttempts) {
        this.put(transitions.release(t, { status: "failed", lastError: "Traitement interrompu trop de fois" }, "Échec : traitement interrompu trop de fois"));
        continue;
      }
      out.push(this.put(transitions.claim(t, workerId, leaseMs, at)));
    }
    return out;
  }

  async get(id: string) {
    const t = this.raw(id);
    return t ? structuredClone(t) : null;
  }

  async listByUser(uid: string, limit = 100) {
    return [...this.tasks.values()].filter((t) => t.uid === uid).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((t) => structuredClone(t));
  }

  async listWaiting(uid: string) {
    return (await this.listByUser(uid, 1000)).filter((t) => t.status === "waiting_user");
  }

  async update(id: string, workerId: string, patch: Partial<Pick<Task, "payload">>, event?: string) {
    const t = assertLease(this.raw(id), workerId);
    return this.put({ ...t, ...patch, history: event ? withEvent(t, event) : t.history, updatedAt: nowIso() });
  }

  async complete(id: string, workerId: string, result: SubmissionResult, event: string) {
    const t = assertLease(this.raw(id), workerId);
    return this.put(transitions.release(t, { status: "done", result, pending: undefined }, event));
  }

  async fail(id: string, workerId: string, error: string, retryInMs: number | null) {
    return this.put(transitions.fail(assertLease(this.raw(id), workerId), error, retryInMs));
  }

  async reschedule(id: string, workerId: string, runAt: string, event: string) {
    const t = assertLease(this.raw(id), workerId);
    return this.put(transitions.release(t, { status: "queued", runAt, attempts: Math.max(0, t.attempts - 1) }, event));
  }

  async pause(id: string, workerId: string, pending: PendingAction) {
    const t = assertLease(this.raw(id), workerId);
    return this.put(transitions.release(t, { status: "waiting_user", pending }, `En attente : ${pending.message}`));
  }

  async cancel(id: string, reason: string, workerId?: string) {
    const t = workerId ? assertLease(this.raw(id), workerId) : this.raw(id);
    if (!t) throw new TaskStateError("Tâche introuvable", 404);
    if (!workerId && t.status === "running") throw new TaskStateError("Candidature en cours de traitement : réessayez dans un instant");
    if (!ACTIVE_STATUSES.has(t.status)) throw new TaskStateError("Cette candidature est déjà terminée");
    return this.put(transitions.release(t, { status: "cancelled", pending: undefined }, `Annulée : ${reason}`));
  }

  async resume(id: string, uid: string, resolution: Resolution) {
    const t = this.raw(id);
    if (!t) throw new TaskStateError("Tâche introuvable", 404);
    return this.put(transitions.resume(t, uid, resolution));
  }
}

export class MemoryAutomationStore implements AutomationStore {
  readonly kind = "memory" as const;
  queue: TaskQueue = new MemoryTaskQueue();
  private settings = new Map<string, AutomationSettings>();
  private profiles = new Map<string, any>();
  private answers = new Map<string, Map<string, SavedAnswer>>();
  private vault = new Map<string, Map<string, VaultEntry>>();
  private submissions = new Map<string, Submission[]>();
  private devices = new Map<string, Set<string>>();
  private slots = new Map<string, number>();
  private mail = new Map<string, MailConnection>();
  private offers = new Map<string, Map<string, DiscoveredOffer>>();
  private discovery = new Map<string, DiscoveryState>();
  private boards = new Map<string, KnownBoard>();

  private bucket<T>(map: Map<string, Map<string, T>>, uid: string) {
    let b = map.get(uid);
    if (!b) map.set(uid, (b = new Map()));
    return b;
  }

  async getSettings(uid: string) {
    return { ...DEFAULT_SETTINGS, ...this.settings.get(uid) };
  }
  async saveSettings(uid: string, s: AutomationSettings) {
    this.settings.set(uid, { ...s });
  }
  /** Tests / développement : profil d'un utilisateur. */
  setProfile(uid: string, profile: any) {
    this.profiles.set(uid, profile);
  }
  async getProfile(uid: string) {
    return this.profiles.get(uid) ?? null;
  }
  async listAnswers(uid: string) {
    return [...this.bucket(this.answers, uid).values()];
  }
  async saveAnswer(uid: string, a: SavedAnswer) {
    this.bucket(this.answers, uid).set(a.key, { ...a });
  }
  async deleteAnswer(uid: string, key: string) {
    this.bucket(this.answers, uid).delete(key);
  }
  async listVault(uid: string) {
    return [...this.bucket(this.vault, uid).values()];
  }
  async saveVault(uid: string, e: VaultEntry) {
    this.bucket(this.vault, uid).set(e.id, { ...e });
  }
  async deleteVault(uid: string, id: string) {
    this.bucket(this.vault, uid).delete(id);
  }
  async recordSubmission(uid: string, s: Submission) {
    this.submissions.set(uid, [...(this.submissions.get(uid) || []), s]);
  }
  async listSubmissionsSince(uid: string, sinceIso: string) {
    return (this.submissions.get(uid) || []).filter((s) => s.submittedAt >= sinceIso);
  }
  async listDeviceTokens(uid: string) {
    return [...(this.devices.get(uid) || [])];
  }
  async saveDeviceToken(uid: string, token: string) {
    this.devices.set(uid, new Set([...(this.devices.get(uid) || []), token]));
  }
  async deleteDeviceToken(uid: string, token: string) {
    this.devices.get(uid)?.delete(token);
  }
  async getMailConnection(uid: string, provider: MailConnection["provider"]) {
    const c = this.mail.get(`${uid}:${provider}`);
    return c ? { ...c } : null;
  }
  async saveMailConnection(uid: string, conn: MailConnection) {
    this.mail.set(`${uid}:${conn.provider}`, { ...conn });
  }
  async deleteMailConnection(uid: string, provider: MailConnection["provider"]) {
    this.mail.delete(`${uid}:${provider}`);
  }
  async upsertOffers(uid: string, offers: DiscoveredOffer[]) {
    const b = this.bucket(this.offers, uid);
    let added = 0;
    for (const o of offers) {
      const prev = b.get(o.id);
      if (!prev) added++;
      b.set(o.id, prev ? { ...o, status: prev.status, taskId: prev.taskId, firstSeenAt: prev.firstSeenAt } : { ...o });
    }
    return { added };
  }
  async listOffers(uid: string, limit = 300) {
    return [...this.bucket(this.offers, uid).values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, limit).map((o) => ({ ...o }));
  }
  async getOffer(uid: string, id: string) {
    const o = this.bucket(this.offers, uid).get(id);
    return o ? { ...o } : null;
  }
  async updateOffer(uid: string, id: string, patch: Partial<Pick<DiscoveredOffer, "status" | "taskId">>) {
    const b = this.bucket(this.offers, uid);
    const o = b.get(id);
    if (o) b.set(id, { ...o, ...patch });
  }
  async getDiscovery(uid: string) {
    const d = this.discovery.get(uid);
    return d ? { ...d } : null;
  }
  async saveDiscovery(uid: string, state: DiscoveryState) {
    this.discovery.set(uid, { ...state });
  }
  async claimDueDiscoveries(limit: number, leaseMs: number) {
    const now = nowIso();
    const due = [...this.discovery.entries()].filter(([, d]) => d.enabled && d.nextRunAt <= now).sort((a, b) => a[1].nextRunAt.localeCompare(b[1].nextRunAt)).slice(0, limit);
    for (const [uid, d] of due) this.discovery.set(uid, { ...d, nextRunAt: new Date(Date.now() + leaseMs).toISOString() });
    return due.map(([uid]) => uid);
  }
  async saveBoards(boards: Omit<KnownBoard, "lastSeenAt">[]) {
    for (const b of boards) this.boards.set(b.id, { ...b, lastSeenAt: nowIso() });
  }
  async listBoards(limit: number) {
    return [...this.boards.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, limit);
  }
  async acquireNotificationSlot(uid: string, key: string, windowMs: number) {
    const k = `${uid}:${key}`;
    const last = this.slots.get(k) || 0;
    if (Date.now() - last < windowMs) return false;
    this.slots.set(k, Date.now());
    return true;
  }
}
