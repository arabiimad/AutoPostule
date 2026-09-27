/**
 * Stockage Firestore de l'agent, contre l'émulateur Firestore :
 *   npm run test:firestore
 * Ignoré sans émulateur (FIRESTORE_EMULATOR_HOST absent).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const skip = !process.env.FIRESTORE_EMULATOR_HOST && 'émulateur Firestore absent (npm run test:firestore)';

test('Firestore : anti-doublon, réservation concurrente, pause/reprise, données utilisateur', { skip }, async () => {
  process.env.FIRESTORE_DATABASE_ID = '(default)';
  const { FirestoreAutomationStore } = await import('../server/automation/firestoreStore.ts');
  const store = await FirestoreAutomationStore.create();
  const uid = `u-${Date.now()}`;
  const input = { uid, type: 'apply' as const, dedupeKey: 'globex|dev|lyon', payload: { job: { title: 'Dev', company: 'Globex' }, origin: 'user' as const } };

  // Deux ajouts simultanés : une seule tâche
  const [a, b] = await Promise.all([store.queue.enqueue(input), store.queue.enqueue(input)]);
  assert.equal([a.created, b.created].filter(Boolean).length, 1);
  assert.equal(a.task.id, b.task.id);

  // Deux workers en concurrence : un seul obtient la tâche
  const [w1, w2] = await Promise.all([store.queue.claim('w1', 5, 60_000), store.queue.claim('w2', 5, 60_000)]);
  const mine = [...w1, ...w2].filter((t) => t.uid === uid);
  assert.equal(mine.length, 1);
  const worker = w1.some((t) => t.uid === uid) ? 'w1' : 'w2';
  const id = mine[0].id;

  await assert.rejects(store.queue.pause(id, worker === 'w1' ? 'w2' : 'w1', { kind: 'approve', message: 'x', createdAt: '' }));
  await store.queue.pause(id, worker, { kind: 'approve', message: 'Validez', createdAt: new Date().toISOString() });
  assert.equal((await store.queue.listWaiting(uid)).length, 1);
  const resumed = await store.queue.resume(id, uid, { approved: true });
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.resolution?.approved, true);
  assert.equal(resumed.pending, undefined);

  const [again] = (await store.queue.claim('w3', 50, 60_000)).filter((t) => t.uid === uid);
  const done = await store.queue.complete(again.id, 'w3', { channel: 'email', details: {}, submittedAt: new Date().toISOString() }, 'Envoyée');
  assert.equal(done.status, 'done');
  assert.equal((await store.queue.enqueue(input)).created, false, 'offre déjà envoyée : pas de nouvelle tâche');
  assert.equal((await store.queue.listByUser(uid)).length, 1);

  // Données par utilisateur
  const settings = await store.getSettings(uid);
  await store.saveSettings(uid, { ...settings, dailyCap: 7 });
  assert.equal((await store.getSettings(uid)).dailyCap, 7);
  await store.saveAnswer(uid, { key: 'k', label: 'Q', category: 'other', answer: 'R', updatedAt: '' });
  assert.equal((await store.listAnswers(uid))[0].answer, 'R');
  await store.recordSubmission(uid, { id: 's1', taskId: id, jobKey: 'k', company: 'Globex', jobTitle: 'Dev', channel: 'email', submittedAt: new Date().toISOString() });
  assert.equal((await store.listSubmissionsSince(uid, '2000-01-01')).length, 1);
  await store.saveDeviceToken(uid, 'tok');
  assert.deepEqual(await store.listDeviceTokens(uid), ['tok']);
  assert.equal(await store.acquireNotificationSlot(uid, 'digest', 60_000), true);
  assert.equal(await store.acquireNotificationSlot(uid, 'digest', 60_000), false);
});
