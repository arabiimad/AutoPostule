/**
 * API de l'auto-candidature sur un vrai PostgreSQL (AUTOMATION_PG), avec un faux serveur OAuth Google.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import express from 'express';
import pg from 'pg';
import type { AddressInfo } from 'node:net';

const ARGS = (process.env.AUTOMATION_PG || '').split(/\s+/).filter(Boolean);
const skip = ARGS.length === 0 ? 'AUTOMATION_PG non défini (PostgreSQL local requis)' : false;
const arg = (f: string) => { const i = ARGS.indexOf(f); return i >= 0 ? ARGS[i + 1] : undefined; };
const DB = `kareer_routes_${process.pid}`;
const A = '00000000-0000-0000-0000-0000000000a1';
const B = '00000000-0000-0000-0000-0000000000b1';

// Faux fournisseur OAuth (échange du code d'autorisation)
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;
const oauth = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const p = new URLSearchParams(body);
    res.setHeader('Content-Type', 'application/json');
    if (p.get('code') !== 'code-valide') { res.statusCode = 400; return res.end('{"error":"invalid_grant"}'); }
    res.end(JSON.stringify({ access_token: 'acces-secret', refresh_token: 'refresh-secret', expires_in: 3599, scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken('Karim@Gmail.com') }));
  });
});
await new Promise<void>((r) => oauth.listen(0, r));
const oauthPort = (oauth.address() as AddressInfo).port;
Object.assign(process.env, {
  AUTOMATION_TOKEN_KEY: 'cle-de-test-routes', GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret',
  GOOGLE_TOKEN_URL: `http://localhost:${oauthPort}/token`, GOOGLE_REVOKE_URL: `http://localhost:${oauthPort}/revoke`, PUBLIC_URL: 'https://kareer.test', AUTOMATION_MAX_DAILY: '5'
});
const { registerAutomationRoutes, setAutomationPool, signState, verifyState } = await import('../server/routes/automation.ts');
const { decryptToken } = await import('../server/automation/email.ts');

let pool: pg.Pool;
let server: http.Server;
let base = '';
const call = async (method: string, path: string, uid?: string, body?: unknown) => {
  const r = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(uid ? { 'x-test-uid': uid } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* redirection */ }
  return { status: r.status, json, location: r.headers.get('location') };
};
const q = async (t: string, v: unknown[] = []) => (await pool.query(t, v)).rows;

before(async () => {
  const app = express();
  app.use(express.json());
  // Authentification simulée : l'identifiant du compte vient d'un en-tête de test
  registerAutomationRoutes(app, { auth: (req: any, _res: any, next: any) => { req.uid = req.headers['x-test-uid']; next(); } });
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  if (skip) return;
  execFileSync('psql', [...ARGS, '-d', 'postgres', '-qc', `drop database if exists ${DB}`, '-c', `create database ${DB}`]);
  for (const f of ['tests/sql/supabase-shim.sql', 'supabase/migrations/001_init.sql', 'supabase/migrations/002_automation.sql']) {
    execFileSync('psql', [...ARGS, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f], { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  pool = new pg.Pool({ host: arg('-h'), port: Number(arg('-p') || 5432), user: arg('-U'), password: process.env.PGPASSWORD, database: DB });
  await q(`insert into auth.users (id) values ($1), ($2)`, [A, B]);
  setAutomationPool(pool);
});
after(async () => {
  server?.close();
  oauth.close();
  if (!skip) await pool.end();
});

const enable = { enabled: true, roles: ['développeur'], contracts: ['cdi'], locations: ['Avignon'], channels: ['email'], minFit: 60, dailyLimit: 3 };

test('service non configuré : 501 ; sans compte : 401', async () => {
  setAutomationPool(null);
  assert.equal((await call('GET', '/api/automation', A)).status, 501);
  if (skip) return;
  setAutomationPool(pool);
  assert.equal((await call('GET', '/api/automation')).status, 401);
});

test('activation : consentement explicite obligatoire, puis première recherche lancée', { skip }, async () => {
  const refused = await call('PUT', '/api/automation/policy', A, enable);
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /autorisez l'envoi automatique/);
  const ok = await call('PUT', '/api/automation/policy', A, { ...enable, consent: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.policy.enabled, true);
  assert.ok(ok.json.policy.consentedAt);
  assert.equal((await q(`select count(*)::int as n from public.automation_tasks where user_id = $1 and kind = 'search'`, [A]))[0].n, 1);
});

test('réglages validés : limite quotidienne de la bêta, métier et canal requis', { skip }, async () => {
  assert.equal((await call('PUT', '/api/automation/policy', A, { ...enable, consent: true, dailyLimit: 50 })).status, 400);
  assert.equal((await call('PUT', '/api/automation/policy', A, { ...enable, consent: true, roles: [] })).status, 400);
  assert.equal((await call('PUT', '/api/automation/policy', A, { ...enable, consent: true, channels: ['pigeon'] })).status, 400);
  const r = await call('PUT', '/api/automation/policy', A, { ...enable, consent: true, contracts: ['cdi', 'inventé'] });
  assert.deepEqual(r.json.policy.contracts, ['cdi']);
});

test('pause puis reprise, journalisées', { skip }, async () => {
  assert.equal((await call('POST', '/api/automation/pause', A)).json.paused, true);
  assert.equal((await q(`select paused from public.automation_policies where user_id = $1`, [A]))[0].paused, true);
  assert.equal((await call('POST', '/api/automation/resume', A)).json.paused, false);
  const st = await call('GET', '/api/automation', A);
  assert.ok(st.json.events.some((e: any) => /pause/.test(e.message)));
});

test('isolation : un autre compte ne voit ni les réglages ni l’activité', { skip }, async () => {
  const st = await call('GET', '/api/automation', B);
  assert.equal(st.status, 200);
  assert.equal(st.json.policy, null);
  assert.equal(st.json.events.length, 0);
  assert.equal((await call('POST', '/api/automation/pause', B)).status, 404);
});

test('OAuth Gmail : état signé, falsification refusée, jetons stockés chiffrés', { skip }, async () => {
  const start = await call('POST', '/api/automation/connect/gmail', A);
  const url = new URL(start.json.url);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://kareer.test/api/automation/oauth/gmail/callback');
  assert.match(url.searchParams.get('scope')!, /gmail\.send/);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  const state = url.searchParams.get('state')!;
  assert.equal(verifyState(state, 'gmail'), A);
  assert.equal(verifyState(state, 'outlook'), null);
  assert.equal(verifyState(signState(A, 'gmail', Date.now() - 11 * 60_000), 'gmail'), null, 'état expiré');

  // État falsifié (compte B substitué) : refusé
  const [body, sig] = state.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), uid: B })).toString('base64url') + '.' + sig;
  assert.match((await call('GET', `/api/automation/oauth/gmail/callback?code=code-valide&state=${forged}`)).location!, /messagerie=refusee/);
  assert.match((await call('GET', `/api/automation/oauth/gmail/callback?code=mauvais&state=${state}`)).location!, /messagerie=erreur/);

  const ok = await call('GET', `/api/automation/oauth/gmail/callback?code=code-valide&state=${state}`);
  assert.match(ok.location!, /messagerie=connectee/);
  const [c] = await q(`select email, access_token_enc, refresh_token_enc from public.mail_connections where user_id = $1`, [A]);
  assert.equal(c.email, 'karim@gmail.com');
  assert.doesNotMatch(c.access_token_enc + c.refresh_token_enc, /secret/);
  assert.equal(decryptToken(c.refresh_token_enc), 'refresh-secret');
  const st = await call('GET', '/api/automation', A);
  assert.deepEqual(st.json.connections, [{ provider: 'gmail', email: 'karim@gmail.com', status: 'active', tracksReplies: false }]);
  assert.doesNotMatch(JSON.stringify(st.json), /secret|token_enc/);
});

test('déconnexion : jetons supprimés', { skip }, async () => {
  assert.equal((await call('DELETE', '/api/automation/connections/gmail', A)).status, 200);
  assert.equal((await q(`select count(*)::int as n from public.mail_connections where user_id = $1`, [A]))[0].n, 0);
});

test('questions de formulaire : listées, réponses enregistrées une fois, offre relancée', { skip }, async () => {
  await q(`insert into public.job_offers (id, source, source_ref, title, offer_url) values ('gh-1', 'test', '1', 'Dev', 'https://job-boards.greenhouse.io/acme/jobs/1')`);
  await q(`insert into public.automation_events (user_id, type, message, data) values ($1, 'questions', 'Questions', $2)`,
    [A, JSON.stringify({ offerId: 'gh-1', questions: [{ key: 'permis-b', label: 'Avez-vous le permis B ?' }] })]);
  let st = await call('GET', '/api/automation', A);
  assert.deepEqual(st.json.questions, [{ key: 'permis-b', label: 'Avez-vous le permis B ?' }]);
  assert.equal((await call('POST', '/api/automation/answers', A, { answers: [{ key: '../../x', answer: 'y' }] })).status, 400);
  const r = await call('POST', '/api/automation/answers', A, { answers: [{ key: 'permis-b', question: 'Avez-vous le permis B ?', answer: 'Oui' }] });
  assert.deepEqual([r.json.saved, r.json.requeued], [1, 1]);
  st = await call('GET', '/api/automation', A);
  assert.deepEqual(st.json.questions, []);
  assert.equal((await q(`select answer from public.personal_answers where user_id = $1 and question_key = 'permis-b'`, [A]))[0].answer, 'Oui');
  assert.equal((await call('GET', '/api/automation', B)).json.questions.length, 0, 'isolation');
});

test('notifications : abonnement de l’appareil enregistré puis supprimé, adresse non https refusée', { skip }, async () => {
  execFileSync('psql', [...ARGS, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', 'supabase/migrations/003_push.sql'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', keys: { p256dh: 'BPk', auth: 'au' } };
  assert.equal((await call('POST', '/api/automation/push', A, { subscription: { ...sub, endpoint: 'http://evil.test' } })).status, 400);
  assert.equal((await call('POST', '/api/automation/push', A, { subscription: sub })).status, 200);
  assert.equal((await q(`select user_id from public.push_subscriptions`))[0].user_id, A);
  assert.equal((await call('DELETE', '/api/automation/push', B, { endpoint: sub.endpoint })).status, 200);
  assert.equal((await q(`select count(*)::int as n from public.push_subscriptions`))[0].n, 1, 'un autre compte ne peut pas le supprimer');
  await call('DELETE', '/api/automation/push', A, { endpoint: sub.endpoint });
  assert.equal((await q(`select count(*)::int as n from public.push_subscriptions`))[0].n, 0);
});
