/**
 * Worker d'auto-candidature sur un vrai PostgreSQL (migrations 001 + 002), avec de faux services d'envoi.
 * AUTOMATION_PG : arguments psql (ex. « -h /var/tmp/kareer-pg -p 5433 -U postgres »). Sans elle : ignoré.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
process.env.AUTOMATION_TOKEN_KEY = 'cle-de-test-pour-les-jetons-de-messagerie';
const { PgAutomationStore } = await import('../server/automation/pgStore.ts');
const { runOnce, autoApplicationId } = await import('../server/automation/worker.ts');
const { encryptToken } = await import('../server/automation/email.ts');

const ARGS = (process.env.AUTOMATION_PG || '').split(/\s+/).filter(Boolean);
const skip = ARGS.length === 0 ? 'AUTOMATION_PG non défini (PostgreSQL local requis)' : false;
const arg = (flag: string) => { const i = ARGS.indexOf(flag); return i >= 0 ? ARGS[i + 1] : undefined; };
const DB = `kareer_worker_${process.pid}`;
const U = '00000000-0000-0000-0000-0000000000c1';
let pool: pg.Pool;
let store: InstanceType<typeof PgAutomationStore>;

const profile = { fullName: 'Karim Dupont', title: 'Développeur web', skills: ['React', 'TypeScript'], experiences: [{ title: 'Développeur web', company: 'Studio X', bullets: ['React'] }] };
const offer = (id: string) => ({ id, source: 'Test', title: 'Développeur React H/F', company: `Entreprise ${id}`, location: 'Avignon', contractType: 'cdi', remote: 'hybride', skillsRequired: ['React', 'TypeScript'], description: `Envoyez votre CV à recrutement@${id}.fr`, applyUrl: `https://www.indeed.fr/${id}`, publishedAt: 'pas une date' });

function deps(sent: string[], send?: () => Promise<any>) {
  return {
    store, workerId: `w-${Math.random().toString(36).slice(2, 7)}`,
    prepare: async () => ({
      cv: { tailored: { headline: 'Développeur', summary: '', experiences: [], skillsOrder: [], highlights: [] }, analysis: {}, rejected: [], source: 'ai', reviewed: true, far: false, notices: [], models: [] },
      letter: { source: 'ai', letter: 'Madame, Monsieur, …' }, ready: { ok: true, reasons: [] }
    }),
    renderCvPdf: async () => Buffer.from('%PDF-1.7'),
    sendMail: async (_p: string, _t: string, mail: any) => { sent.push(mail.to); await new Promise(r => setTimeout(r, 20)); if (send) return send(); return { provider: 'gmail', messageId: `m-${sent.length}`, acceptedAt: new Date().toISOString() }; },
    refreshAccessToken: async () => ({ accessToken: 'a', expiresAt: new Date(Date.now() + 3600e3).toISOString() })
  } as any;
}
const q = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows;
const addOffers = async (ids: string[]) => {
  await store.upsertOffers(ids.map(offer));
  for (const id of ids) await store.enqueue({ userId: U, kind: 'process_offer', offerId: id });
};

before(async () => {
  if (skip) return;
  const base = [...ARGS];
  execFileSync('psql', [...base, '-d', 'postgres', '-qc', `drop database if exists ${DB}`, '-c', `create database ${DB}`]);
  for (const f of ['tests/sql/supabase-shim.sql', 'supabase/migrations/001_init.sql', 'supabase/migrations/002_automation.sql']) {
    execFileSync('psql', [...base, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f], { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  pool = new pg.Pool({ host: arg('-h'), port: Number(arg('-p') || 5432), user: arg('-U'), password: process.env.PGPASSWORD, database: DB });
  store = new PgAutomationStore(pool);
  await q(`insert into auth.users (id) values ($1)`, [U]);
  await q(`insert into public.profiles (id, data) values ($1, $2)`, [U, profile]);
  await q(`insert into public.automation_policies (user_id, enabled, roles, daily_limit, channels) values ($1, true, '{développeur}', 20, '{email}')`, [U]);
  await q(`insert into public.mail_connections (user_id, provider, email, access_token_enc, refresh_token_enc, expires_at) values ($1, 'gmail', 'karim@gmail.com', $2, $3, now() + interval '1 hour')`, [U, encryptToken('a'), encryptToken('r')]);
});
after(async () => { if (!skip) await pool.end(); });

test('envoi complet : tentative prouvée, dossier « envoyée » visible dans l’application, date inconnue non inventée', { skip }, async () => {
  const sent: string[] = [];
  await addOffers(['pg1']);
  await runOnce(deps(sent), { limit: 5 });
  assert.deepEqual(sent, ['recrutement@pg1.fr']);
  const [a] = await q(`select status, proof->>'messageId' as mid, destination from public.application_attempts where offer_id = 'pg1'`);
  assert.deepEqual([a.status, a.mid, a.destination], ['submitted', 'm-1', 'recrutement@pg1.fr']);
  const [app] = await q(`select status, data->'automation'->>'state' as state from public.applications where id = $1`, [autoApplicationId('pg1')]);
  assert.deepEqual([app.status, app.state], ['applied', 'submitted']);
  const [o] = await q(`select published_at from public.job_offers where id = 'pg1'`);
  assert.equal(o.published_at, null);
  assert.ok((await q(`select 1 from public.automation_events where type = 'submitted'`)).length === 1);
});

test('deux workers simultanés : chaque offre envoyée exactement une fois', { skip }, async () => {
  const sent: string[] = [];
  const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
  await addOffers(ids);
  await Promise.all([runOnce(deps(sent), { limit: 6 }), runOnce(deps(sent), { limit: 6 }), runOnce(deps(sent), { limit: 6 })]);
  assert.equal(sent.length, 6);
  assert.equal(new Set(sent).size, 6);
  assert.equal((await q(`select count(*)::int as n from public.application_attempts where offer_id = any($1) and status = 'submitted'`, [ids]))[0].n, 6);
});

test('délai dépassé : résultat incertain, la même offre remise en file n’est jamais renvoyée', { skip }, async () => {
  const sent: string[] = [];
  await addOffers(['u1']);
  await runOnce(deps(sent, async () => { throw new Error('timeout'); }), { limit: 5 });
  await store.enqueue({ userId: U, kind: 'process_offer', offerId: 'u1' });
  await runOnce(deps(sent), { limit: 5 });
  assert.equal(sent.length, 1);
  assert.equal((await q(`select status from public.application_attempts where offer_id = 'u1'`))[0].status, 'uncertain');
});

test('limite quotidienne appliquée par la base', { skip }, async () => {
  await q(`update public.automation_policies set daily_limit = (select count(*) from public.application_attempts where status = 'submitted' or status = 'uncertain') + 1 where user_id = $1`, [U]);
  const sent: string[] = [];
  await addOffers(['l1', 'l2']);
  await runOnce(deps(sent), { limit: 5 });
  assert.equal(sent.length, 1);
  const deferred = await q(`select 1 from public.automation_tasks where offer_id in ('l1', 'l2') and status = 'queued' and run_after > now() + interval '1 minute'`);
  assert.equal(deferred.length, 1);
});
