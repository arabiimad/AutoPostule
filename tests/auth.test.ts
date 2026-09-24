import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { authMiddleware } from '../server/auth.ts';

// Faux service Supabase Auth : « bon-jeton » → utilisateur, sinon 401
let server: http.Server;
before(async () => {
  server = http.createServer((req, res) => {
    const ok = req.url === '/auth/v1/user' && req.headers.authorization === 'Bearer bon-jeton' && !!req.headers.apikey;
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { id: 'user-123', email: 'a@b.fr' } : { msg: 'invalid' }));
  }).listen(0);
  await new Promise((r) => server.once('listening', r));
  process.env.SUPABASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.SUPABASE_ANON_KEY = 'cle-publique';
});
after(() => server.close());

function run(mode: string, authorization?: string, options: { optional?: boolean } = {}) {
  if (mode) process.env.AUTH_MODE = mode;
  else delete process.env.AUTH_MODE;
  const mw = authMiddleware(options);
  return new Promise<{ next: boolean; status?: number; uid?: string }>((resolve) => {
    const req: any = { headers: authorization ? { authorization } : {} };
    const res: any = { status: (s: number) => ({ json: () => resolve({ next: false, status: s }) }) };
    mw(req, res, () => resolve({ next: true, uid: req.uid }));
  });
}

test('mode optional : requête sans jeton acceptée', async () => {
  assert.deepEqual(await run('optional'), { next: true, uid: undefined });
});

test('mode required : requête sans jeton refusée (401)', async () => {
  assert.equal((await run('required')).status, 401);
});

test('jeton valide : compte identifié', async () => {
  assert.deepEqual(await run('required', 'Bearer bon-jeton'), { next: true, uid: 'user-123' });
});

test('jeton invalide refusé (401), même en mode optional', async () => {
  assert.equal((await run('optional', 'Bearer pas-un-vrai-jeton')).status, 401);
});

test('mode off : aucune vérification', async () => {
  assert.equal((await run('off', 'Bearer x')).next, true);
});

test('sans AUTH_MODE et avec Supabase configuré : compte exigé (production)', async () => {
  assert.equal((await run('')).status, 401);
});

test('routes ouvertes aux visiteurs (forfaits) : acceptées sans jeton même en mode required', async () => {
  assert.deepEqual(await run('required', undefined, { optional: true }), { next: true, uid: undefined });
  assert.deepEqual(await run('required', 'Bearer bon-jeton', { optional: true }), { next: true, uid: 'user-123' });
});
