/**
 * Migrations de l'auto-candidature testées sur un vrai PostgreSQL (psql).
 * Base de test : AUTOMATION_PG (ex. « -h /var/tmp/kareer-pg -p 5433 -U postgres »). Sans elle, les tests sont ignorés.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CONN = (process.env.AUTOMATION_PG || '').split(/\s+/).filter(Boolean);
const skip = CONN.length === 0 ? 'AUTOMATION_PG non défini (PostgreSQL local requis)' : false;
const DB = `kareer_test_${process.pid}`;

const psqlArgs = (db: string, sql: string) => [...CONN, '-d', db, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', sql];
const sql = async (q: string) => (await run('psql', psqlArgs(DB, q))).stdout.trim();
/** Requête exécutée comme un utilisateur connecté (rôle authenticated + identifiant JWT). */
const asUser = (uid: string, q: string) =>
  sql(`begin; set local role authenticated; set local request.jwt.claim.sub = '${uid}'; ${q}; commit;`);

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';

before(async () => {
  if (skip) return;
  execFileSync('psql', [...CONN, '-d', 'postgres', '-qc', `drop database if exists ${DB}`, '-c', `create database ${DB}`]);
  for (const f of ['tests/sql/supabase-shim.sql', 'supabase/migrations/001_init.sql', 'supabase/migrations/002_automation.sql']) {
    execFileSync('psql', [...CONN, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f], { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  await sql(`insert into auth.users (id, email) values ('${A}', 'a@test.fr'), ('${B}', 'b@test.fr')`);
  await sql(`insert into public.job_offers (id, source, source_ref, title, offer_url)
             select 'offre-' || g, 'test', g::text, 'Poste ' || g, 'https://exemple.fr/' || g from generate_series(1, 40) g`);
});

test('file de tâches : 4 workers simultanés ne réservent jamais deux fois la même tâche', { skip }, async () => {
  await sql(`insert into public.automation_tasks (user_id, kind, payload) select '${A}', 'search', jsonb_build_object('n', g) from generate_series(1, 20) g`);
  const results = await Promise.all([1, 2, 3, 4].map((w) =>
    sql(`select id from public.claim_automation_tasks('worker-${w}', 10, 60)`)));
  const ids = results.flatMap((r) => r.split('\n').filter(Boolean));
  assert.equal(ids.length, 20);
  assert.equal(new Set(ids).size, 20);
});

test('bail expiré : la tâche est reprise, et l’ancien worker ne peut plus la terminer', { skip }, async () => {
  const id = await sql(`insert into public.automation_tasks (user_id, kind) values ('${A}', 'track_replies') returning id`);
  await sql(`select 1 from public.claim_automation_tasks('ancien', 50, 60)`);
  await sql(`update public.automation_tasks set locked_until = now() - interval '1 second' where id = ${id}`);
  const reclaimed = await sql(`select id from public.claim_automation_tasks('nouveau', 50, 60) where id = ${id}`);
  assert.equal(reclaimed, id);
  assert.equal(await sql(`select public.finish_automation_task(${id}, 'ancien', 'done')`), 'f');
  assert.equal(await sql(`select public.finish_automation_task(${id}, 'nouveau', 'done')`), 't');
  assert.equal(await sql(`select status from public.automation_tasks where id = ${id}`), 'done');
});

test('nouvel essai différé puis échec définitif après le nombre maximal de tentatives', { skip }, async () => {
  const id = await sql(`insert into public.automation_tasks (user_id, kind, max_attempts) values ('${B}', 'search', 2) returning id`);
  for (let i = 0; i < 2; i++) {
    await sql(`update public.automation_tasks set run_after = now() where id = ${id}`);
    assert.equal(await sql(`select id from public.claim_automation_tasks('w', 50, 60) where id = ${id}`), id);
    await sql(`select public.finish_automation_task(${id}, 'w', 'queued', 'réseau', 30)`);
  }
  assert.equal(await sql(`select status from public.automation_tasks where id = ${id}`), 'failed');
});

test('réservation d’envoi : désactivée par défaut, puis limite quotidienne exacte malgré 10 demandes simultanées', { skip }, async () => {
  const reserve = (offer: string) =>
    sql(`select coalesce(attempt_id::text, reason) from public.reserve_application_attempt('${A}', '${offer}', 'email', 'rh@exemple.fr', 'v1', '[]', '{}')`);
  assert.equal(await reserve('offre-1'), 'AUTOMATION_DISABLED');
  await sql(`insert into public.automation_policies (user_id, enabled, daily_limit) values ('${A}', true, 5)`);
  const out = await Promise.all(Array.from({ length: 10 }, (_, i) => reserve(`offre-${i + 1}`)));
  assert.equal(out.filter((r) => /^[0-9a-f-]{36}$/.test(r)).length, 5, out.join(','));
  assert.equal(out.filter((r) => r === 'DAILY_LIMIT').length, 5);
});

test('une seule tentative par candidat et par offre', { skip }, async () => {
  await sql(`update public.automation_policies set daily_limit = 20 where user_id = '${A}'`);
  const reserve = () => sql(`select coalesce(attempt_id::text, reason) from public.reserve_application_attempt('${A}', 'offre-1', 'email', 'rh@exemple.fr', 'v1', '[]', '{}')`);
  const first = await reserve();
  assert.equal(await reserve(), first, 'pas de seconde tentative : la même est reprise');
  assert.equal(await sql(`select public.begin_submission('${first}')`), 'OK');
  assert.equal(await reserve(), 'ALREADY_ATTEMPTED');
  await assert.rejects(sql(`insert into public.application_attempts (user_id, offer_id, channel, destination) values ('${A}', 'offre-1', 'email', 'x@y.fr')`));
});

test('pause juste avant l’envoi : la tentative est annulée, rien n’est envoyé', { skip }, async () => {
  const id = await sql(`select attempt_id from public.reserve_application_attempt('${A}', 'offre-30', 'email', 'rh@exemple.fr', 'v1', '[]', '{}')`);
  await sql(`update public.automation_policies set paused = true where user_id = '${A}'`);
  assert.equal(await sql(`select public.begin_submission('${id}')`), 'PAUSED');
  assert.equal(await sql(`select status from public.application_attempts where id = '${id}'`), 'cancelled');
  await sql(`update public.automation_policies set paused = false where user_id = '${A}'`);
  const id2 = await sql(`select attempt_id from public.reserve_application_attempt('${A}', 'offre-31', 'email', 'rh@exemple.fr', 'v1', '[]', '{}')`);
  assert.equal(await sql(`select public.begin_submission('${id2}')`), 'OK');
  assert.equal(await sql(`select public.begin_submission('${id2}')`), 'NOT_RESERVED');
});

test('isolation : chaque utilisateur ne voit que ses tentatives et ne peut pas en créer', { skip }, async () => {
  assert.ok(Number(await asUser(A, 'select count(*) from public.application_attempts')) > 0);
  assert.equal(await asUser(B, 'select count(*) from public.application_attempts'), '0');
  await assert.rejects(asUser(B, `insert into public.application_attempts (user_id, offer_id, channel, destination) values ('${B}', 'offre-2', 'email', 'x@y.fr')`));
  await assert.rejects(asUser(A, `update public.application_attempts set status = 'confirmed'`));
  await assert.rejects(asUser(A, `select public.reserve_application_attempt('${A}', 'offre-3', 'email', 'x@y.fr', 'v', '[]', '{}')`));
});

test('jetons OAuth jamais lisibles par le client', { skip }, async () => {
  await sql(`insert into public.mail_connections (user_id, provider, email, access_token_enc, refresh_token_enc) values ('${A}', 'gmail', 'a@gmail.com', 'chiffré', 'chiffré')`);
  assert.equal(await asUser(A, 'select email from public.mail_connections'), 'a@gmail.com');
  await assert.rejects(asUser(A, 'select access_token_enc from public.mail_connections'));
  await assert.rejects(asUser(A, 'select * from public.mail_connections'));
  assert.equal(await asUser(B, 'select count(email) from public.mail_connections'), '0');
});

test('reprise : une tentative jamais envoyée peut reprendre ; après le début de l’envoi, plus jamais', { skip }, async () => {
  const reserve = (offer: string) =>
    sql(`select coalesce(attempt_id::text, reason) from public.reserve_application_attempt('${B}', '${offer}', 'email', 'rh@exemple.fr', 'v1', '[]', '{}')`);
  await sql(`insert into public.automation_policies (user_id, enabled, daily_limit) values ('${B}', true, 10)`);
  const id = await reserve('offre-20');
  assert.equal(await sql(`select public.record_submission('${id}', 'needs_user', null, 'Messagerie à reconnecter')`), 't');
  assert.equal(await reserve('offre-20'), id, 'même tentative reprise');
  assert.equal(await sql(`select public.begin_submission('${id}')`), 'OK');
  assert.equal(await sql(`select public.record_submission('${id}', 'uncertain', null, 'délai dépassé')`), 't');
  assert.equal(await reserve('offre-20'), 'ALREADY_ATTEMPTED');
  // Transitions interdites : un envoi incertain ne redevient pas « réservé » ni « échoué »
  assert.equal(await sql(`select public.record_submission('${id}', 'failed')`), 'f');
  assert.equal(await sql(`select public.record_submission('${id}', 'confirmed', '{"messageId":"m1"}')`), 't');
  assert.equal(await sql(`select status || ':' || (proof->>'messageId') from public.application_attempts where id = '${id}'`), 'confirmed:m1');
});
