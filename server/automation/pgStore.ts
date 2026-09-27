/**
 * Stockage de l'auto-candidature sur PostgreSQL (base Supabase, connexion directe du worker).
 * AUTOMATION_DATABASE_URL : chaîne de connexion Supabase (rôle postgres ou service, pooler en mode session).
 * Toutes les règles critiques (réservation exclusive, unicité, limite quotidienne, pause) sont appliquées par
 * les fonctions SQL de supabase/migrations/002_automation.sql.
 */
import pg from "pg";
import type { AutomationStore, Task, MailConnection, ReserveInput, AttemptStatus, TaskStatus, TaskKind, TrackableAttempt } from "./store.ts";
import { policyFromRow } from "./policy.ts";
import { sendPushToUser } from "./push.ts";

const validDate = (v: unknown) => {
  const d = v ? new Date(String(v)) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

/** SSL requis pour une base distante (Supabase) ; pas pour une base locale, une socket ou sslmode=disable. */
export function needsSsl(url: string): boolean {
  try {
    // « postgresql://user@/base?host=/socket » n'a pas d'hôte : URL() le refuse sans un hôte fictif
    const u = new URL(url.replace(/^(postgres(?:ql)?:\/\/[^/@]*@)\//, "$1localhost/"));
    if (u.searchParams.get("sslmode") === "disable") return false;
    const host = u.searchParams.get("host") || u.hostname;
    return !(host.startsWith("/") || ["localhost", "127.0.0.1", "::1", ""].includes(host));
  } catch {
    return true;
  }
}

export class PgAutomationStore implements AutomationStore {
  constructor(readonly pool: pg.Pool) {}

  static fromEnv(): PgAutomationStore | null {
    const url = process.env.AUTOMATION_DATABASE_URL;
    if (!url) return null;
    return new PgAutomationStore(new pg.Pool({ connectionString: url, max: 5, ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined }));
  }

  private async q<T = any>(text: string, values: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(text, values)).rows as T[];
  }

  async claimTasks(worker: string, limit: number, leaseSeconds: number): Promise<Task[]> {
    const rows = await this.q(`select * from public.claim_automation_tasks($1, $2, $3)`, [worker, limit, leaseSeconds]);
    return rows.map((r) => ({ id: Number(r.id), userId: r.user_id, kind: r.kind, offerId: r.offer_id, payload: r.payload || {}, attempts: r.attempts, maxAttempts: r.max_attempts }));
  }

  async finishTask(id: number, worker: string, status: Exclude<TaskStatus, "running">, error: string | null = null, retrySeconds?: number) {
    const [r] = await this.q(`select public.finish_automation_task($1, $2, $3, $4, $5) as ok`, [id, worker, status, error, retrySeconds ?? null]);
    return !!r?.ok;
  }

  async enqueue(task: { userId: string; kind: TaskKind; offerId?: string | null; payload?: Record<string, any>; runAfterSeconds?: number }) {
    const rows = await this.q(
      `insert into public.automation_tasks (user_id, kind, offer_id, payload, run_after)
       values ($1, $2, $3, $4, now() + make_interval(secs => $5))
       on conflict do nothing returning id`,
      [task.userId, task.kind, task.offerId ?? null, task.payload || {}, task.runAfterSeconds || 0]
    );
    return rows.length === 1;
  }

  async getPolicy(userId: string) {
    const [r] = await this.q(`select * from public.automation_policies where user_id = $1`, [userId]);
    return r ? policyFromRow(r) : null;
  }

  async getProfile(userId: string) {
    const [r] = await this.q(`select data from public.profiles where id = $1`, [userId]);
    return r?.data ?? null;
  }

  async getOffer(offerId: string) {
    const [r] = await this.q(`select * from public.job_offers where id = $1`, [offerId]);
    if (!r) return null;
    return {
      ...(r.data || {}),
      id: r.id, title: r.title, company: r.company, location: r.location, contractType: r.contract ?? undefined,
      applyUrl: r.data?.applyUrl || r.offer_url, applyChannel: r.apply_channel ?? undefined,
      publishedAt: r.published_at ?? undefined, expiresAt: r.expires_at ?? undefined
    };
  }

  async upsertOffers(offers: any[]) {
    for (const o of offers) {
      if (!o?.id || !o?.title) continue;
      await this.q(
        `insert into public.job_offers (id, source, source_ref, title, company, location, contract, offer_url, published_at, expires_at, verified_at, data)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11)
         on conflict (id) do update set title = excluded.title, company = excluded.company, location = excluded.location,
           contract = excluded.contract, offer_url = excluded.offer_url, published_at = coalesce(excluded.published_at, job_offers.published_at),
           expires_at = excluded.expires_at, verified_at = now(), data = excluded.data`,
        [o.id, String(o.source || "inconnue"), String(o.sourceRef || o.id), o.title, o.company || "", o.location || "",
         o.contractType || null, o.applyUrl || o.url || "", validDate(o.publishedAt), validDate(o.expiresAt), o]
      );
    }
  }

  async reserveAttempt(input: ReserveInput) {
    const [r] = await this.q(
      `select attempt_id, reason from public.reserve_application_attempt($1, $2, $3, $4, $5, $6, $7)`,
      [input.userId, input.offerId, input.channel, input.destination, input.profileVersion, JSON.stringify(input.documents), JSON.stringify(input.answers)]
    );
    return { attemptId: r?.attempt_id ?? null, reason: r?.reason ?? null };
  }

  async beginSubmission(attemptId: string) {
    const [r] = await this.q(`select public.begin_submission($1) as s`, [attemptId]);
    return r?.s;
  }

  async recordSubmission(attemptId: string, status: AttemptStatus, proof: Record<string, any> | null = null, error: string | null = null) {
    const [r] = await this.q(`select public.record_submission($1, $2, $3, $4) as ok`, [attemptId, status, proof ? JSON.stringify(proof) : null, error]);
    return !!r?.ok;
  }

  async getMailConnection(userId: string): Promise<MailConnection | null> {
    const [r] = await this.q(`select * from public.mail_connections where user_id = $1 and status = 'active' order by updated_at desc limit 1`, [userId]);
    if (!r) return null;
    return { provider: r.provider, email: r.email, status: r.status, accessTokenEnc: r.access_token_enc, refreshTokenEnc: r.refresh_token_enc, expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null, scopes: r.scopes || [] };
  }

  async getPersonalAnswers(userId: string) {
    const rows = await this.q(`select question_key, answer from public.personal_answers where user_id = $1`, [userId]);
    return Object.fromEntries(rows.map((r) => [r.question_key, r.answer]));
  }

  async saveMailTokens(userId: string, provider: string, tokens: any) {
    if ("status" in tokens) {
      await this.q(`update public.mail_connections set status = $3 where user_id = $1 and provider = $2`, [userId, provider, tokens.status]);
      return;
    }
    await this.q(
      `update public.mail_connections set access_token_enc = $3, refresh_token_enc = coalesce($4, refresh_token_enc), expires_at = $5, status = 'active'
       where user_id = $1 and provider = $2`,
      [userId, provider, tokens.accessTokenEnc, tokens.refreshTokenEnc ?? null, tokens.expiresAt]
    );
  }

  async upsertApplication(userId: string, application: Record<string, any>) {
    await this.q(
      `insert into public.applications (user_id, id, data) values ($1, $2, $3)
       on conflict (user_id, id) do update set data = public.applications.data || excluded.data`,
      [userId, application.id, JSON.stringify(application)]
    );
  }

  async logEvent(userId: string, type: string, message: string, data: Record<string, any> = {}, refs: { taskId?: number; attemptId?: string } = {}) {
    await this.q(
      `insert into public.automation_events (user_id, task_id, attempt_id, type, message, data) values ($1, $2, $3, $4, $5, $6)`,
      [userId, refs.taskId ?? null, refs.attemptId ?? null, type, message, JSON.stringify(data)]
    );
  }

  /**
   * Planifie une recherche pour chaque automatisation active sans recherche depuis `everyHours` heures
   * (verrou consultatif : plusieurs workers ne planifient jamais deux fois).
   */
  async scheduleSearches(everyHours: number): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('automation:schedule'))");
      const r = await client.query(
        `insert into public.automation_tasks (user_id, kind)
         select p.user_id, 'search' from public.automation_policies p
          where p.enabled and not p.paused
            and not exists (select 1 from public.automation_tasks t
                             where t.user_id = p.user_id and t.kind = 'search'
                               and (t.status in ('queued', 'running') or t.created_at > now() - make_interval(hours => $1)))`,
        [everyHours]
      );
      await client.query("commit");
      return r.rowCount || 0;
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** Envois interrompus (worker arrêté pendant l'envoi) : « résultat incertain », jamais renvoyés automatiquement. */
  async sweepInterruptedSubmissions(olderThanMinutes = 10): Promise<number> {
    const rows = await this.q(
      `update public.application_attempts set status = 'uncertain', error = 'Envoi interrompu : vérifiez vos messages envoyés.'
        where status = 'submitting' and submitting_at < now() - make_interval(mins => $1) returning user_id, offer_id`,
      [olderThanMinutes]
    );
    for (const r of rows) await this.logEvent(r.user_id, "uncertain", "Envoi interrompu : vérifiez vos messages envoyés avant de renvoyer.", { offerId: r.offer_id });
    return rows.length;
  }

  async listTrackableAttempts(userId: string): Promise<TrackableAttempt[]> {
    const rows = await this.q(
      `select a.id, a.offer_id, a.channel, a.destination, a.status, coalesce(a.submitted_at, a.submitting_at, a.created_at) as since, o.company, o.title
         from public.application_attempts a join public.job_offers o on o.id = a.offer_id
        where a.user_id = $1 and a.status in ('submitted', 'confirmed', 'uncertain') and a.created_at > now() - interval '60 days'`,
      [userId]
    );
    return rows.map((r) => ({ attemptId: r.id, offerId: r.offer_id, company: r.company, title: r.title, channel: r.channel, destination: r.destination, status: r.status, since: new Date(r.since).toISOString() }));
  }

  async hasProcessedReply(userId: string, messageId: string) {
    return (await this.q(`select 1 from public.automation_events where user_id = $1 and type = 'reply' and data->>'messageId' = $2 limit 1`, [userId, messageId])).length > 0;
  }

  /** Suivi des réponses planifié pour les comptes qui l'ont autorisé et ont des candidatures récentes. */
  async scheduleReplyTracking(everyHours: number): Promise<number> {
    const r = await this.pool.query(
      `insert into public.automation_tasks (user_id, kind)
       select distinct c.user_id, 'track_replies' from public.mail_connections c
        where c.status = 'active' and c.scopes && array['https://www.googleapis.com/auth/gmail.readonly', 'https://graph.microsoft.com/Mail.Read', 'Mail.Read']
          and exists (select 1 from public.application_attempts a where a.user_id = c.user_id and a.status in ('submitted', 'confirmed', 'uncertain') and a.created_at > now() - interval '60 days')
          and not exists (select 1 from public.automation_tasks t where t.user_id = c.user_id and t.kind = 'track_replies'
                            and (t.status in ('queued', 'running') or t.created_at > now() - make_interval(hours => $1)))`,
      [everyHours]
    );
    return r.rowCount || 0;
  }

  async notify(userId: string, message: { title: string; body: string; url: string; tag?: string }) {
    try {
      await sendPushToUser(this.pool, userId, message);
    } catch {
      /* notification facultative : jamais bloquante */
    }
  }

  /**
   * Conservation : preuves détaillées (message, réponses, empreintes) effacées après `proofDays` jours,
   * la ligne de tentative restant pour empêcher toute nouvelle candidature à la même offre ;
   * évènements effacés après `proofDays` jours, tâches terminées après 30 jours.
   */
  async purgeOld(proofDays = 180): Promise<{ proofs: number; events: number; tasks: number }> {
    const proofs = await this.pool.query(
      `update public.application_attempts set proof = null, answers = '{}'::jsonb, documents = '[]'::jsonb, error = null
        where created_at < now() - make_interval(days => $1) and (proof is not null or answers <> '{}'::jsonb or documents <> '[]'::jsonb)`,
      [proofDays]
    );
    const events = await this.pool.query(`delete from public.automation_events where created_at < now() - make_interval(days => $1)`, [proofDays]);
    const tasks = await this.pool.query(`delete from public.automation_tasks where status in ('done', 'cancelled', 'failed') and updated_at < now() - interval '30 days'`);
    return { proofs: proofs.rowCount || 0, events: events.rowCount || 0, tasks: tasks.rowCount || 0 };
  }

  /** Indicateurs de supervision (exploitant), sans aucune donnée personnelle. */
  async supervision() {
    const one = async (text: string) => (await this.pool.query(text)).rows;
    const [tasks] = await one(
      `select count(*) filter (where status = 'queued')::int as queued,
              count(*) filter (where status = 'running' and locked_until >= now())::int as running,
              count(*) filter (where status = 'running' and locked_until < now())::int as stuck,
              count(*) filter (where status = 'queued' and run_after < now() - interval '30 minutes')::int as late,
              count(*) filter (where status = 'done' and updated_at > now() - interval '24 hours')::int as done_24h,
              count(*) filter (where status = 'failed' and updated_at > now() - interval '24 hours')::int as failed_24h,
              count(*) filter (where status = 'needs_user' and updated_at > now() - interval '24 hours')::int as needs_user_24h,
              max(updated_at) filter (where status in ('done', 'failed', 'needs_user', 'uncertain', 'cancelled')) as last_finished
         from public.automation_tasks`
    );
    const attempts = await one(
      `select channel, status, count(*)::int as n from public.application_attempts
        where created_at > now() - interval '7 days' group by channel, status order by channel, status`
    );
    const errors = await one(
      `select channel, left(coalesce(error, ''), 80) as error, count(*)::int as n from public.application_attempts
        where created_at > now() - interval '7 days' and status in ('failed', 'uncertain', 'needs_user') and error is not null
        group by channel, left(coalesce(error, ''), 80) order by n desc limit 20`
    );
    const [users] = await one(`select count(*) filter (where enabled and not paused)::int as active, count(*) filter (where paused)::int as paused from public.automation_policies`);
    return { at: new Date().toISOString(), tasks, attempts, errors, users };
  }

  async close() {
    await this.pool.end();
  }
}
