/**
 * Synchronisation (migration 004) sur un vrai PostgreSQL : fusion des modifications, versions, conflits, isolation.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CONN = (process.env.AUTOMATION_PG || '').split(/\s+/).filter(Boolean);
const skip = CONN.length === 0 ? 'AUTOMATION_PG non défini (PostgreSQL local requis)' : false;
const DB = `kareer_sync_${process.pid}`;
const sql = async (q: string) => (await run('psql', [...CONN, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', q])).stdout.trim();
const asUser = (uid: string, q: string) => sql(`begin; set local role authenticated; set local request.jwt.claim.sub = '${uid}'; ${q}; commit;`);
const A = '00000000-0000-0000-0000-0000000000d1';
const B = '00000000-0000-0000-0000-0000000000d2';

before(() => {
  if (skip) return;
  execFileSync('psql', [...CONN, '-d', 'postgres', '-qc', `drop database if exists ${DB}`, '-c', `create database ${DB}`]);
  for (const f of ['tests/sql/supabase-shim.sql', 'supabase/migrations/001_init.sql', 'supabase/migrations/002_automation.sql', 'supabase/migrations/003_push.sql', 'supabase/migrations/004_sync.sql']) {
    execFileSync('psql', [...CONN, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f], { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  execFileSync('psql', [...CONN, '-d', DB, '-qc', `insert into auth.users (id) values ('${A}'), ('${B}');
    insert into public.applications (user_id, id, data) values ('${A}', 'app-1', '{"id":"app-1","status":"prepared","jobTitle":"Dev","automation":{"state":"submitted"}}')`]);
});

test('modification partielle : les champs écrits ailleurs (candidature automatique) sont préservés', { skip }, async () => {
  const out = await asUser(A, `select version || '|' || data::text from public.patch_application('app-1', '{"status":"interview","respondedAt":"2026-09-27"}')`);
  const [version, data] = out.split('|');
  assert.equal(version, '2');
  const d = JSON.parse(data);
  assert.deepEqual([d.status, d.respondedAt, d.automation.state, d.jobTitle], ['interview', '2026-09-27', 'submitted', 'Dev']);
  assert.equal(await sql(`select status from public.applications where id = 'app-1'`), 'interview', 'colonne de statut à jour');
});

test('modification partielle : null retire le champ', { skip }, async () => {
  const d = JSON.parse(await asUser(A, `select data::text from public.patch_application('app-1', '{"respondedAt":null}')`));
  assert.equal('respondedAt' in d, false);
  assert.equal(d.status, 'interview');
});

test('isolation : un autre compte ne peut pas modifier ce dossier', { skip }, async () => {
  assert.equal(await asUser(B, `select count(*) from public.patch_application('app-1', '{"status":"rejected"}')`), '0');
  assert.equal(await sql(`select status from public.applications where id = 'app-1'`), 'interview');
});

test('profil : création, mise à jour, conflit entre deux appareils signalé sans écrasement', { skip }, async () => {
  const save = (data: string, expected: string) => asUser(A, `select ok || '|' || version || '|' || data::text from public.save_profile('${data}', ${expected})`);
  assert.match(await save('{"fullName":"Karim"}', 'null'), /^true\|1\|/);
  // Téléphone et ordinateur partent tous deux de la version 1
  assert.match(await save('{"fullName":"Karim D."}', '1'), /^true\|2\|/);
  const conflict = await save('{"fullName":"Karim Dupont"}', '1');
  assert.match(conflict, /^false\|2\|/);
  assert.match(conflict, /Karim D\./, 'la version la plus récente est renvoyée');
  assert.equal(await sql(`select data->>'fullName' from public.profiles where id = '${A}'`), 'Karim D.');
  assert.match(await asUser(B, `select ok || '|' || version from public.save_profile('{"fullName":"B"}', null)`), /^true\|1$/, 'profil séparé pour B');
});

test('visiteur non connecté : aucune écriture', { skip }, async () => {
  await assert.rejects(sql(`begin; set local role anon; select public.save_profile('{}', null); commit;`));
  await assert.rejects(sql(`begin; set local role anon; select public.patch_application('app-1', '{}'); commit;`));
});
