/**
 * Stockage Firestore de l'agent (production) : partagé par toutes les instances Cloud Run.
 *
 * Collections (accessibles uniquement par le serveur : les règles Firestore refusent le navigateur) :
 *   automation_tasks/{taskId}
 *   users/{uid}/automation/settings
 *   users/{uid}/answers/{key}
 *   users/{uid}/vault/{id}
 *   users/{uid}/submissions/{id}
 *   users/{uid}/devices/{sha1(token)}
 *   users/{uid}/automation/notify_{key}
 *   automation_dedupe/{sha1(uid|offre)}  (une seule candidature par offre)
 *
 * La base du projet est en édition Enterprise : aucun index n'est obligatoire. En édition Standard,
 * créer les index composites de automation_tasks : (status, runAt), (status, leaseUntil),
 * (uid, createdAt desc), (uid, status).
 * Tests contre l'émulateur : npm run test:firestore
 */
import { createHash } from "node:crypto";
import {
  ACTIVE_STATUSES, DEFAULT_SETTINGS, TaskStateError, assertLease, isClaimable, newTask, transitions, withEvent,
  type AutomationStore, type TaskQueue
} from "./store.ts";
import { adminFirestore } from "./firebaseAdmin.ts";
import type { AutomationSettings, NewTask, PendingAction, Resolution, SavedAnswer, Submission, SubmissionResult, Task, VaultEntry } from "./types.ts";

type Db = Awaited<ReturnType<typeof adminFirestore>>;

/** Firestore refuse les valeurs undefined : on les retire. */
function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

const TASKS = "automation_tasks";
const nowIso = () => new Date().toISOString();

class FirestoreTaskQueue implements TaskQueue {
  constructor(private db: Db) {}

  private col() {
    return this.db.collection(TASKS);
  }

  /** Modifie une tâche dans une transaction : lecture, contrôle, écriture. */
  private async mutate(id: string, fn: (task: Task | null) => Task): Promise<Task> {
    const ref = this.col().doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const next = fn(snap.exists ? (snap.data() as Task) : null);
      tx.set(ref, clean(next));
      return next;
    });
  }

  async enqueue(input: NewTask) {
    // Clé déterministe : deux ajouts simultanés de la même offre ne créent qu'une tâche
    const lockRef = this.db.collection("automation_dedupe").doc(createHash("sha1").update(`${input.uid}|${input.dedupeKey}`).digest("hex"));
    return this.db.runTransaction(async (tx) => {
      const lock = await tx.get(lockRef);
      if (lock.exists) {
        const existingRef = this.col().doc(String(lock.get("taskId")));
        const existing = await tx.get(existingRef);
        const t = existing.data() as Task | undefined;
        if (t && (ACTIVE_STATUSES.has(t.status) || t.status === "done")) return { task: t, created: false };
      }
      const ref = this.col().doc();
      const task = newTask(input, ref.id);
      tx.set(ref, clean(task));
      tx.set(lockRef, { taskId: ref.id, uid: input.uid, createdAt: task.createdAt });
      return { task, created: true };
    });
  }

  async claim(workerId: string, limit: number, leaseMs: number) {
    const at = new Date();
    const iso = at.toISOString();
    const [ready, expired] = await Promise.all([
      this.col().where("status", "==", "queued").where("runAt", "<=", iso).orderBy("runAt").limit(limit).get(),
      this.col().where("status", "==", "running").where("leaseUntil", "<=", iso).orderBy("leaseUntil").limit(limit).get()
    ]);
    const out: Task[] = [];
    for (const doc of [...ready.docs, ...expired.docs].slice(0, limit)) {
      try {
        let claimed: Task | null = null;
        await this.mutate(doc.id, (t) => {
          // Un autre worker a pu la prendre entre la requête et la transaction
          if (!t || !isClaimable(t, at)) throw new TaskStateError("déjà prise");
          if (t.status === "running" && t.attempts >= t.maxAttempts) {
            return transitions.release(t, { status: "failed", lastError: "Traitement interrompu trop de fois" }, "Échec : traitement interrompu trop de fois");
          }
          claimed = transitions.claim(t, workerId, leaseMs, at);
          return claimed;
        });
        if (claimed) out.push(claimed);
      } catch (e) {
        if (!(e instanceof TaskStateError)) throw e;
      }
    }
    return out;
  }

  async get(id: string) {
    const snap = await this.col().doc(id).get();
    return snap.exists ? (snap.data() as Task) : null;
  }

  async listByUser(uid: string, limit = 100) {
    const snap = await this.col().where("uid", "==", uid).orderBy("createdAt", "desc").limit(limit).get();
    return snap.docs.map((d) => d.data() as Task);
  }

  async listWaiting(uid: string) {
    const snap = await this.col().where("uid", "==", uid).where("status", "==", "waiting_user").get();
    return snap.docs.map((d) => d.data() as Task).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  update(id: string, workerId: string, patch: Partial<Pick<Task, "payload">>, event?: string) {
    return this.mutate(id, (t) => {
      const task = assertLease(t, workerId);
      return { ...task, ...patch, history: event ? withEvent(task, event) : task.history, updatedAt: nowIso() };
    });
  }

  complete(id: string, workerId: string, result: SubmissionResult, event: string) {
    return this.mutate(id, (t) => transitions.release(assertLease(t, workerId), { status: "done", result, pending: undefined }, event));
  }

  fail(id: string, workerId: string, error: string, retryInMs: number | null) {
    return this.mutate(id, (t) => transitions.fail(assertLease(t, workerId), error, retryInMs));
  }

  reschedule(id: string, workerId: string, runAt: string, event: string) {
    return this.mutate(id, (t) => {
      const task = assertLease(t, workerId);
      return transitions.release(task, { status: "queued", runAt, attempts: Math.max(0, task.attempts - 1) }, event);
    });
  }

  pause(id: string, workerId: string, pending: PendingAction) {
    return this.mutate(id, (t) => transitions.release(assertLease(t, workerId), { status: "waiting_user", pending }, `En attente : ${pending.message}`));
  }

  cancel(id: string, reason: string, workerId?: string) {
    return this.mutate(id, (t) => {
      const task = workerId ? assertLease(t, workerId) : t;
      if (!task) throw new TaskStateError("Tâche introuvable", 404);
      if (!workerId && task.status === "running") throw new TaskStateError("Candidature en cours de traitement : réessayez dans un instant");
      if (!ACTIVE_STATUSES.has(task.status)) throw new TaskStateError("Cette candidature est déjà terminée");
      return transitions.release(task, { status: "cancelled", pending: undefined }, `Annulée : ${reason}`);
    });
  }

  resume(id: string, uid: string, resolution: Resolution) {
    return this.mutate(id, (t) => {
      if (!t) throw new TaskStateError("Tâche introuvable", 404);
      return transitions.resume(t, uid, resolution);
    });
  }
}

export class FirestoreAutomationStore implements AutomationStore {
  readonly kind = "firestore" as const;
  queue: TaskQueue;

  constructor(private db: Db) {
    this.queue = new FirestoreTaskQueue(db);
  }

  static async create() {
    return new FirestoreAutomationStore(await adminFirestore());
  }

  private user(uid: string) {
    return this.db.collection("users").doc(uid);
  }

  async getSettings(uid: string): Promise<AutomationSettings> {
    const snap = await this.user(uid).collection("automation").doc("settings").get();
    return { ...DEFAULT_SETTINGS, ...(snap.exists ? snap.data() : {}) } as AutomationSettings;
  }
  async saveSettings(uid: string, settings: AutomationSettings) {
    await this.user(uid).collection("automation").doc("settings").set(clean(settings));
  }
  async getProfile(uid: string) {
    const snap = await this.user(uid).get();
    return snap.exists ? snap.data() : null;
  }
  async listAnswers(uid: string) {
    return (await this.user(uid).collection("answers").get()).docs.map((d) => d.data() as SavedAnswer);
  }
  async saveAnswer(uid: string, a: SavedAnswer) {
    await this.user(uid).collection("answers").doc(a.key).set(clean(a));
  }
  async deleteAnswer(uid: string, key: string) {
    await this.user(uid).collection("answers").doc(key).delete();
  }
  async listVault(uid: string) {
    return (await this.user(uid).collection("vault").get()).docs.map((d) => d.data() as VaultEntry);
  }
  async saveVault(uid: string, e: VaultEntry) {
    await this.user(uid).collection("vault").doc(e.id).set(clean(e));
  }
  async deleteVault(uid: string, id: string) {
    await this.user(uid).collection("vault").doc(id).delete();
  }
  async recordSubmission(uid: string, s: Submission) {
    await this.user(uid).collection("submissions").doc(s.id).set(clean(s));
  }
  async listSubmissionsSince(uid: string, sinceIso: string) {
    const snap = await this.user(uid).collection("submissions").where("submittedAt", ">=", sinceIso).get();
    return snap.docs.map((d) => d.data() as Submission);
  }
  private deviceId(token: string) {
    return createHash("sha1").update(token).digest("hex");
  }
  async listDeviceTokens(uid: string) {
    return (await this.user(uid).collection("devices").get()).docs.map((d) => String(d.get("token")));
  }
  async saveDeviceToken(uid: string, token: string) {
    await this.user(uid).collection("devices").doc(this.deviceId(token)).set({ token, updatedAt: nowIso() });
  }
  async deleteDeviceToken(uid: string, token: string) {
    await this.user(uid).collection("devices").doc(this.deviceId(token)).delete();
  }
  async acquireNotificationSlot(uid: string, key: string, windowMs: number) {
    const ref = this.user(uid).collection("automation").doc(`notify_${key}`);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const last = snap.exists ? Date.parse(String(snap.get("at"))) || 0 : 0;
      if (Date.now() - last < windowMs) return false;
      tx.set(ref, { at: nowIso() });
      return true;
    });
  }
}
