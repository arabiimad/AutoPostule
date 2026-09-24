import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authMiddleware } from '../server/auth.ts';

function run(mode: string, authorization?: string) {
  process.env.AUTH_MODE = mode;
  const mw = authMiddleware();
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

test('jeton invalide refusé (401), même en mode optional', async () => {
  assert.equal((await run('optional', 'Bearer pas-un-vrai-jeton')).status, 401);
});

test('mode off : aucune vérification', async () => {
  assert.equal((await run('off', 'Bearer x')).next, true);
});
