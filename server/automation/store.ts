/**
 * Accès aux données de l'auto-candidature. En production : Supabase (fonctions SQL de la migration 002,
 * appelées avec la clé service_role). En test : implémentation en mémoire qui applique les mêmes règles.
 */
import type { AutomationPolicy } from "./policy.ts";

export type TaskKind = "search" | "process_offer" | "verify_submission" | "track_replies";
export type TaskStatus = "queued" | "running" | "done" | "failed" | "needs_user" | "uncertain" | "cancelled";
export type AttemptStatus = "reserved" | "submitting" | "submitted" | "confirmed" | "uncertain" | "failed" | "needs_user" | "cancelled";

export interface Task {
  id: number;
  userId: string;
  kind: TaskKind;
  offerId: string | null;
  payload: Record<string, any>;
  attempts: number;
  maxAttempts: number;
}

export interface MailConnection {
  provider: "gmail" | "outlook";
  email: string;
  status: "active" | "revoked" | "error";
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  expiresAt: string | null;
}

export interface ReserveInput {
  userId: string;
  offerId: string;
  channel: "email" | "lever" | "greenhouse";
  destination: string;
  profileVersion: string;
  documents: { kind: string; name: string; sha256: string; bytes: number }[];
  answers: Record<string, string>;
}

export interface AutomationStore {
  claimTasks(worker: string, limit: number, leaseSeconds: number): Promise<Task[]>;
  finishTask(id: number, worker: string, status: Exclude<TaskStatus, "running">, error?: string | null, retrySeconds?: number): Promise<boolean>;
  enqueue(task: { userId: string; kind: TaskKind; offerId?: string | null; payload?: Record<string, any>; runAfterSeconds?: number }): Promise<boolean>;
  getPolicy(userId: string): Promise<AutomationPolicy | null>;
  getProfile(userId: string): Promise<any | null>;
  getOffer(offerId: string): Promise<any | null>;
  upsertOffers(offers: any[]): Promise<void>;
  reserveAttempt(input: ReserveInput): Promise<{ attemptId: string | null; reason: string | null }>;
  beginSubmission(attemptId: string): Promise<"OK" | "PAUSED" | "NOT_RESERVED" | "NOT_FOUND">;
  recordSubmission(attemptId: string, status: AttemptStatus, proof?: Record<string, any> | null, error?: string | null): Promise<boolean>;
  getMailConnection(userId: string): Promise<MailConnection | null>;
  saveMailTokens(userId: string, provider: string, tokens: { accessTokenEnc: string; refreshTokenEnc?: string; expiresAt: string } | { status: "revoked" | "error" }): Promise<void>;
  /** Dossier visible dans l'application (tableau Candidatures). */
  upsertApplication(userId: string, application: Record<string, any>): Promise<void>;
  logEvent(userId: string, type: string, message: string, data?: Record<string, any>, refs?: { taskId?: number; attemptId?: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implémentation en mémoire (tests, développement local sans Supabase)
// ---------------------------------------------------------------------------
export class MemoryAutomationStore implements AutomationStore {
  tasks: (Task & { status: TaskStatus; runAfter: number; lockedBy: string | null; lockedUntil: number; lastError: string | null })[] = [];
  policies = new Map<string, AutomationPolicy>();
  profiles = new Map<string, any>();
  offers = new Map<string, any>();
  attempts = new Map<string, ReserveInput & { id: string; status: AttemptStatus; proof: any; error: string | null; createdAt: number }>();
  mail = new Map<string, MailConnection>();
  applications = new Map<string, Record<string, any>>();
  events: { userId: string; type: string; message: string; data?: any }[] = [];
  private seq = 0;
  now = () => Date.now();

  async claimTasks(worker: string, limit: number, leaseSeconds: number) {
    const t = this.now();
    const ready = this.tasks
      .filter((x) => (x.status === "queued" && x.runAfter <= t) || (x.status === "running" && x.lockedUntil < t && x.attempts < x.maxAttempts))
      .slice(0, limit);
    for (const x of ready) Object.assign(x, { status: "running", lockedBy: worker, lockedUntil: t + leaseSeconds * 1000, attempts: x.attempts + 1 });
    return ready.map(({ id, userId, kind, offerId, payload, attempts, maxAttempts }) => ({ id, userId, kind, offerId, payload, attempts, maxAttempts }));
  }

  async finishTask(id: number, worker: string, status: Exclude<TaskStatus, "running">, error: string | null = null, retrySeconds = 60) {
    const x = this.tasks.find((y) => y.id === id);
    if (!x || x.lockedBy !== worker || x.status !== "running") return false;
    x.status = status === "queued" && x.attempts >= x.maxAttempts ? "failed" : status;
    x.lastError = error;
    if (status === "queued") x.runAfter = this.now() + retrySeconds * 1000;
    x.lockedBy = null;
    return true;
  }

  async enqueue(task: { userId: string; kind: TaskKind; offerId?: string | null; payload?: Record<string, any>; runAfterSeconds?: number }) {
    const dup = this.tasks.some((x) => x.userId === task.userId && x.kind === task.kind && task.offerId && x.offerId === task.offerId && ["queued", "running"].includes(x.status));
    if (dup) return false;
    this.tasks.push({
      id: ++this.seq, userId: task.userId, kind: task.kind, offerId: task.offerId ?? null, payload: task.payload || {},
      attempts: 0, maxAttempts: 3, status: "queued", runAfter: this.now() + (task.runAfterSeconds || 0) * 1000, lockedBy: null, lockedUntil: 0, lastError: null
    });
    return true;
  }

  async getPolicy(userId: string) { return this.policies.get(userId) || null; }
  async getProfile(userId: string) { return this.profiles.get(userId) || null; }
  async getOffer(offerId: string) { return this.offers.get(offerId) || null; }
  async upsertOffers(offers: any[]) { for (const o of offers) this.offers.set(o.id, { ...this.offers.get(o.id), ...o }); }

  async reserveAttempt(input: ReserveInput) {
    const pol = this.policies.get(input.userId);
    if (!pol?.enabled) return { attemptId: null, reason: "AUTOMATION_DISABLED" };
    if (pol.paused) return { attemptId: null, reason: "AUTOMATION_PAUSED" };
    const prev = [...this.attempts.values()].find((a) => a.userId === input.userId && a.offerId === input.offerId);
    if (prev && ["submitting", "submitted", "confirmed", "uncertain"].includes(prev.status)) return { attemptId: null, reason: "ALREADY_ATTEMPTED" };
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const today = [...this.attempts.values()].filter((a) => a.userId === input.userId && new Date(a.createdAt).toISOString().slice(0, 10) === day && !["failed", "cancelled", "needs_user"].includes(a.status)).length;
    if (today >= pol.dailyLimit) return { attemptId: null, reason: "DAILY_LIMIT" };
    const id = prev?.id || `att-${++this.seq}`;
    this.attempts.set(id, { ...input, id, status: "reserved", proof: null, error: null, createdAt: this.now() });
    return { attemptId: id, reason: null };
  }

  async beginSubmission(attemptId: string) {
    const a = this.attempts.get(attemptId);
    if (!a) return "NOT_FOUND" as const;
    if (a.status !== "reserved") return "NOT_RESERVED" as const;
    const pol = this.policies.get(a.userId);
    if (!pol?.enabled || pol.paused) {
      a.status = "cancelled";
      return "PAUSED" as const;
    }
    a.status = "submitting";
    return "OK" as const;
  }

  async recordSubmission(attemptId: string, status: AttemptStatus, proof: any = null, error: string | null = null) {
    const a = this.attempts.get(attemptId);
    if (!a) return false;
    const ok = (a.status === "submitting" && ["submitted", "uncertain", "failed"].includes(status))
      || (["submitted", "uncertain"].includes(a.status) && status === "confirmed")
      || (a.status === "reserved" && ["needs_user", "cancelled", "failed"].includes(status));
    if (!ok) return false;
    Object.assign(a, { status, proof: proof ?? a.proof, error });
    return true;
  }

  async getMailConnection(userId: string) { return this.mail.get(userId) || null; }
  async saveMailTokens(userId: string, _provider: string, tokens: any) {
    const c = this.mail.get(userId);
    if (!c) return;
    if ("status" in tokens) c.status = tokens.status;
    else Object.assign(c, { accessTokenEnc: tokens.accessTokenEnc, refreshTokenEnc: tokens.refreshTokenEnc ?? c.refreshTokenEnc, expiresAt: tokens.expiresAt });
  }
  async upsertApplication(userId: string, application: Record<string, any>) {
    this.applications.set(`${userId}:${application.id}`, { ...this.applications.get(`${userId}:${application.id}`), ...application });
  }
  async logEvent(userId: string, type: string, message: string, data?: Record<string, any>) {
    this.events.push({ userId, type, message, data });
  }
}
