/**
 * Contrôle avant mise en production : variables (présence, format) et détection des migrations non appliquées.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { checkEnv, MIGRATION_PROBES } from '../scripts/preflight.ts';

const PROD = {
  SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's',
  VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: 'a', AUTH_MODE: 'required', GEMINI_API_KEY: 'g',
  AUTOMATION_DATABASE_URL: 'postgresql://u:p@h:5432/postgres', AUTOMATION_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
  PUBLIC_URL: 'https://kareer.pro', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec',
  VAPID_PUBLIC_KEY: 'B' + 'x'.repeat(86), VAPID_PRIVATE_KEY: 'p', ADMIN_UIDS: 'u1', FT_CLIENT_ID: 'f', FT_CLIENT_SECRET: 'f'
};
const errors = (env: Record<string, string | undefined>) => checkEnv(env).filter((f) => f.level === 'error').map((f) => f.message);

test('configuration complète : aucun point bloquant', () => {
  assert.deepEqual(errors(PROD), []);
});

test('points bloquants détectés, sans jamais afficher de valeur secrète', () => {
  const env = { ...PROD, AUTH_MODE: 'off', AUTOMATION_TOKEN_KEY: 'zqv-court', PUBLIC_URL: 'http://kareer.pro/app', GOOGLE_CLIENT_ID: '', AUTOMATION_LOCAL_UID: 'x', STRIPE_SECRET_KEY: 'sk_live_zqv9' };
  const e = errors(env).join('\n');
  for (const k of ['AUTH_MODE', 'AUTOMATION_TOKEN_KEY', 'PUBLIC_URL', 'Aucune messagerie', 'AUTOMATION_LOCAL_UID', 'Stripe incomplet']) assert.match(e, new RegExp(k));
  const all = checkEnv(env).map((f) => f.message).join('\n');
  assert.doesNotMatch(all, /zqv/);
});

const CONN = (process.env.AUTOMATION_PG || '').split(/\s+/).filter(Boolean);
test('migrations : une migration manquante est signalée', { skip: CONN.length ? false : 'AUTOMATION_PG non défini' }, () => {
  const DB = `kareer_preflight_${process.pid}`;
  const psql = (args: string[]) => execFileSync('psql', [...CONN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  psql(['-d', 'postgres', '-qc', `drop database if exists ${DB}`, '-c', `create database ${DB}`]);
  try {
    const applied = () => MIGRATION_PROBES.map((m) => psql(['-d', DB, '-qtAc', m.sql]) === 't');
    assert.deepEqual(applied(), [false, false, false, false, false, false, false]);
    for (const f of ['tests/sql/supabase-shim.sql', 'supabase/migrations/001_init.sql', 'supabase/migrations/002_automation.sql', 'supabase/migrations/003_push.sql', 'supabase/migrations/004_sync.sql', 'supabase/migrations/005_billing.sql']) psql(['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f]);
    assert.deepEqual(applied(), [true, true, true, true, true, false, false], '006 non appliquée');
    psql(['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', 'supabase/migrations/006_lba_channel.sql']);
    assert.deepEqual(applied(), [true, true, true, true, true, true, false], '007 non appliquée');
    psql(['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', 'supabase/migrations/007_offer_index.sql']);
    assert.deepEqual(applied(), [true, true, true, true, true, true, true]);
  } finally {
    psql(['-d', 'postgres', '-qc', `drop database if exists ${DB} with (force)`]);
  }
});
