/**
 * Orchestrateur : traite les candidatures de la file, sur le serveur, sans l'utilisateur.
 *
 * Pour chaque tâche : garde-fous → préparation du CV et de la lettre (une seule fois) →
 * validation si le niveau d'automatisation l'exige → choix du canal → envoi → suivi.
 * À chaque besoin de l'utilisateur, la tâche est mise en pause avec une notification groupée ;
 * sa réponse la remet en file et le traitement reprend où il s'était arrêté.
 */
import { randomUUID } from "node:crypto";
import { resolveQuestions, type AiAnswerFn } from "./answers.ts";
import { RetryableError, type ApplyChannel, type ChannelContext } from "./channels.ts";
import { checkGuardrails, jobKey, lookbackStart, needsApproval } from "./guardrails.ts";
import type { Notifier } from "./notifier.ts";
import { TaskStateError, type AutomationStore } from "./store.ts";
import type { PendingAction, PreparedDocuments, Task } from "./types.ts";
import type { Vault } from "./vault.ts";

export type DocumentPreparer = (candidate: any, job: any) => Promise<PreparedDocuments>;

export interface OrchestratorDeps {
  store: AutomationStore;
  vault: Vault;
  notifier: Notifier;
  channels: ApplyChannel[];
  prepare: DocumentPreparer;
  ai?: AiAnswerFn | null;
  log?: (level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>) => void;
  /** Durée du bail d'une tâche (le traitement d'un formulaire peut prendre plusieurs minutes). */
  leaseMs?: number;
}

/** Délai avant nouvelle tentative : 5 min, 30 min, 2 h. */
export function retryDelay(attempt: number): number {
  return [5, 30, 120][Math.min(attempt - 1, 2)] * 60_000;
}

export class Orchestrator {
  private readonly leaseMs: number;
  private readonly log: NonNullable<OrchestratorDeps["log"]>;

  constructor(private deps: OrchestratorDeps) {
    this.leaseMs = deps.leaseMs ?? 10 * 60_000;
    this.log = deps.log ?? (() => {});
  }

  /** Traite les tâches prêtes ; appelée par Cloud Scheduler (/api/automation/tick) ou par la boucle locale. */
  async tick(opts: { limit?: number; concurrency?: number; workerId?: string } = {}) {
    const workerId = opts.workerId || `worker-${randomUUID().slice(0, 8)}`;
    const tasks = await this.deps.store.queue.claim(workerId, opts.limit ?? 10, this.leaseMs);
    const results: { id: string; status: string }[] = [];
    const concurrency = Math.max(1, opts.concurrency ?? 3);
    let next = 0;
    const lane = async () => {
      while (next < tasks.length) {
        const task = tasks[next++];
        results.push({ id: task.id, status: await this.process(task, workerId) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, lane));
    return { workerId, processed: results };
  }

  private async pause(task: Task, workerId: string, pending: Omit<PendingAction, "createdAt">) {
    const t = await this.deps.store.queue.pause(task.id, workerId, { ...pending, createdAt: new Date().toISOString() });
    await this.deps.notifier.onWaiting(task.uid, pending.kind).catch(() => false);
    this.log("info", "automation_waiting_user", { taskId: task.id, kind: pending.kind });
    return t.status;
  }

  /** Traite une tâche réservée ; renvoie son nouveau statut. */
  async process(task: Task, workerId: string): Promise<string> {
    const { store } = this.deps;
    const queue = store.queue;
    try {
      const settings = await store.getSettings(task.uid);
      const resolution = task.resolution || {};

      // 1. Garde-fous (rejoués à chaque reprise : un envoi a pu avoir lieu entre-temps)
      const recent = await store.listSubmissionsSince(task.uid, lookbackStart(settings));
      const guard = checkGuardrails(task, settings, recent);
      if (guard.action === "cancel") return (await queue.cancel(task.id, guard.reason, workerId)).status;
      if (guard.action === "reschedule") return (await queue.reschedule(task.id, workerId, guard.runAt, `Reportée : ${guard.reason}`)).status;

      const candidate = task.payload.candidate || (await store.getProfile(task.uid));
      if (!candidate) return (await queue.fail(task.id, workerId, "profil introuvable", null)).status;

      // 2. Préparation du dossier (conservée dans la tâche : pas de nouvel appel IA aux reprises)
      let documents = task.payload.documents;
      if (!documents) {
        documents = await this.deps.prepare(candidate, task.payload.job);
        task = await queue.update(task.id, workerId, { payload: { ...task.payload, documents } }, "CV et lettre préparés");
      }

      // 3. Validation par l'utilisateur
      if (needsApproval(settings) && !resolution.approved) {
        return this.pause(task, workerId, {
          kind: "approve",
          message: `CV et lettre prêts pour « ${task.payload.job?.title || "l'offre"} » chez ${task.payload.job?.company || "l'entreprise"} : validez l'envoi.`
        });
      }

      if (resolution.coverLetter) documents = { ...documents, coverLetter: resolution.coverLetter };

      // 4. Canal : celui déjà commencé en priorité, puis l'ordre de préférence
      const ordered = [
        ...this.deps.channels.filter((c) => c.id === task.payload.channel),
        ...this.deps.channels.filter((c) => c.id !== task.payload.channel)
      ];
      const saved = await store.listAnswers(task.uid);
      const tried: string[] = [];
      const ctx: ChannelContext = {
        uid: task.uid,
        task,
        job: task.payload.job,
        candidate,
        documents,
        resolution,
        vault: this.deps.vault,
        skipped: tried,
        answer: (questions) =>
          resolveQuestions(questions, { saved, profile: candidate, job: task.payload.job, ai: this.deps.ai, overrides: resolution.answers })
      };

      for (const channel of ordered) {
        if (!(await channel.canHandle(task.payload.job, task.uid))) continue;
        if (task.payload.channel !== channel.id) {
          task = await queue.update(task.id, workerId, { payload: { ...task.payload, channel: channel.id } }, `Canal : ${channel.label}`);
          ctx.task = task;
        }
        const outcome = await channel.apply(ctx);

        if (outcome.kind === "unavailable") {
          tried.push(`${channel.label} (${outcome.reason})`);
          continue;
        }
        if (outcome.kind === "needs_user") return this.pause(task, workerId, outcome.pending);

        const submittedAt = new Date().toISOString();
        const job = task.payload.job || {};
        await store.recordSubmission(task.uid, {
          id: randomUUID(),
          taskId: task.id,
          jobKey: jobKey(job),
          company: String(job.company || ""),
          jobTitle: String(job.title || ""),
          channel: channel.id,
          submittedAt
        });
        this.log("info", "automation_submitted", { taskId: task.id, channel: channel.id });
        return (await queue.complete(task.id, workerId, { channel: channel.id, reference: outcome.reference, details: outcome.details, submittedAt }, `Candidature envoyée (${channel.label})`)).status;
      }

      return (await queue.fail(task.id, workerId, `aucun canal d'envoi disponible${tried.length ? ` : ${tried.join(" ; ")}` : ""}`, null)).status;
    } catch (e: any) {
      const message = String(e?.message || e).slice(0, 500);
      this.log(e instanceof RetryableError ? "warn" : "error", "automation_error", { taskId: task.id, message });
      try {
        return (await queue.fail(task.id, workerId, message, e instanceof RetryableError ? retryDelay(task.attempts) : null)).status;
      } catch {
        return "error";
      }
    }
  }

  /**
   * Réponse de l'utilisateur à une candidature en attente.
   * Les réponses aux questions sont enregistrées dans sa base pour les prochains formulaires.
   */
  async resolve(uid: string, taskId: string, input: {
    action: "approve" | "reject" | "answer" | "code" | "done";
    /** Lettre corrigée par l'utilisateur au moment de valider. */
    coverLetter?: string;
    answers?: Record<string, string>;
    code?: string;
    remember?: boolean;
  }) {
    const { store } = this.deps;
    const task = await store.queue.get(taskId);
    if (!task || task.uid !== uid) throw new TaskStateError("Candidature introuvable", 404);

    if (input.action === "answer" && input.answers && input.remember !== false) {
      const byKey = new Map((task.pending?.questions || []).map((q) => [q.key, q]));
      for (const [key, answer] of Object.entries(input.answers)) {
        const q = byKey.get(key);
        if (!q || !String(answer).trim()) continue;
        await store.saveAnswer(uid, { key, label: q.label, category: q.category, answer: String(answer).trim(), updatedAt: new Date().toISOString() });
      }
    }

    const edited = typeof input.coverLetter === "string" && input.coverLetter.trim() !== "" && input.coverLetter.trim() !== task.payload.documents?.coverLetter?.trim();
    const updated = await store.queue.resume(taskId, uid, {
      ...(input.action === "approve" ? { approved: true, edited: !!edited, ...(edited ? { coverLetter: String(input.coverLetter) } : {}) } : {}),
      ...(input.action === "reject" ? { rejected: true } : {}),
      ...(input.action === "answer" ? { answers: input.answers || {} } : {}),
      ...(input.action === "code" ? { verificationCode: String(input.code || "").trim() } : {}),
      ...(input.action === "done" ? { humanStepDone: true } : {})
    });

    // Confiance progressive : une validation sans correction rapproche de l'envoi automatique, un refus repart de zéro
    if (input.action === "approve" || input.action === "reject") {
      const settings = await store.getSettings(uid);
      const cleanApprovals = input.action === "reject" ? 0 : edited ? settings.cleanApprovals : settings.cleanApprovals + 1;
      if (cleanApprovals !== settings.cleanApprovals) await store.saveSettings(uid, { ...settings, cleanApprovals });
    }
    return updated;
  }
}
