import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createAutomation } from '../server/automation/index.ts';
import { createAutomationRouter } from '../server/automation/routes.ts';
import { MemoryAutomationStore } from '../server/automation/store.ts';

const store = new MemoryAutomationStore();
store.setProfile('alice', { fullName: 'Alice', email: 'alice@example.com', experiences: [{ id: 'e', title: 'Dev', company: 'X', bullets: [] }] });
process.env.AUTOMATION_CRON_SECRET = 'cron-secret';
const automation = await createAutomation({
  store,
  env: { AUTOMATION_WORKER: 'off', AUTOMATION_MAIL: 'simulated', VAULT_KEY: Buffer.alloc(32, 3).toString('base64'), AUTOMATION_CRON_SECRET: 'cron-secret' } as any,
  prepare: async () => ({ coverLetter: 'Lettre', latexCode: 'tex', cvPdfBase64: 'JVBERg==', notices: [], preparedAt: new Date().toISOString() })
});
const app = express();
app.use(express.json());
app.use('/api/automation', createAutomationRouter(automation, { authMode: 'off', production: false }));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/automation`;
after(() => server.close());

async function call(method: string, path: string, body?: any, uid = 'alice', headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-dev-uid': uid, ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() as any };
}

test('API : mise en file, validation, traitement par /tick, isolation entre utilisateurs', async () => {
  const created = await call('POST', '/applications', { job: { title: 'Dev web', company: 'Globex', location: 'Lyon', contactEmail: 'rh@globex.fr' } });
  assert.equal(created.status, 201);
  const id = created.body.task.id;
  assert.equal((await call('POST', '/applications', { job: { title: 'Dev web', company: 'Globex', location: 'Lyon' } })).body.created, false);
  assert.equal((await call('POST', '/applications', { job: { title: '' } })).status, 400);

  // /tick exige le secret
  assert.equal((await call('POST', '/tick', {}, 'alice')).status, 401);
  const tick = await call('POST', '/tick', {}, 'alice', { 'x-automation-secret': 'cron-secret' });
  assert.equal(tick.status, 200);

  const pending = await call('GET', '/tasks?status=waiting_user');
  assert.equal(pending.body.tasks.length, 1);
  assert.equal(pending.body.tasks[0].pending.kind, 'approve');
  assert.equal(pending.body.tasks[0].payload.documents.coverLetter, 'Lettre');
  assert.equal(pending.body.tasks[0].payload.documents.cvPdfBase64, undefined, 'le PDF n\'est pas renvoyé au navigateur');

  // Un autre utilisateur ne voit ni ne valide la candidature
  assert.equal((await call('GET', `/tasks/${id}`, undefined, 'mallory')).status, 404);
  assert.equal((await call('POST', `/tasks/${id}/resolve`, { action: 'approve' }, 'mallory')).status, 404);

  assert.equal((await call('POST', `/tasks/${id}/resolve`, { action: 'approve' })).status, 200);
  await call('POST', '/tick', {}, 'alice', { 'x-automation-secret': 'cron-secret' });
  const done = await call('GET', `/tasks/${id}`);
  assert.equal(done.body.task.status, 'done');
  assert.equal(done.body.task.result.channel, 'email');
});

test('API : réglages bornés, base de réponses, coffre sans mot de passe en clair dans la liste', async () => {
  const s = await call('PUT', '/settings', { level: 'rules', dailyCap: 999 });
  assert.equal(s.body.settings.level, 'rules');
  assert.equal(s.body.settings.dailyCap, 50);

  const a = await call('PUT', '/answers', { label: 'Prétentions salariales ?', answer: '40 k€' });
  assert.equal(a.body.answer.category, 'salary');
  assert.equal((await call('GET', '/answers')).body.answers.length, 1);
  assert.equal((await call('GET', '/answers', undefined, 'bob')).body.answers.length, 0);

  const entry = await automation.vault.save('alice', 'careers.globex.com', 'alice@example.com', 'P@ssw0rd-123');
  const list = await call('GET', '/vault');
  assert.equal(list.body.entries[0].secret, undefined);
  assert.equal((await call('POST', `/vault/${entry.id}/reveal`)).body.password, 'P@ssw0rd-123');
  assert.equal((await call('POST', `/vault/${entry.id}/reveal`, {}, 'bob')).status, 404);
});

test('API : connexion exigée hors mode développement', async () => {
  const prod = express();
  prod.use(express.json());
  prod.use('/api/automation', createAutomationRouter(automation, { authMode: 'optional', production: true }));
  const srv = prod.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/automation/tasks`, { headers: { 'x-dev-uid': 'alice' } });
    assert.equal(res.status, 401);
  } finally {
    srv.close();
  }
});
