import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Outbox, changedKeys, type OutboxApi } from '../src/data/outbox.ts';

function memoryStorage() { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; }
function fakeApi() {
  const apps = new Map<string, any>();
  let profile: { version: number; data: any } | null = null;
  const calls: string[] = [];
  const api: OutboxApi & { online: boolean } = {
    online: true,
    async saveApplication(_u, app) { if (!api.online) throw new TypeError('Failed to fetch'); calls.push(`save:${app.id}`); apps.set(app.id, { ...app }); },
    async patchApplication(_u, id, patch) { if (!api.online) throw new TypeError('Failed to fetch'); calls.push(`patch:${id}:${Object.keys(patch).join(',')}`); const a = apps.get(id); if (!a) return { found: false }; apps.set(id, { ...a, ...patch }); return { found: true }; },
    async deleteApplication(_u, id) { if (!api.online) throw new TypeError('Failed to fetch'); apps.delete(id); },
    async saveProfile(_u, data, expected) {
      if (!api.online) throw new TypeError('Failed to fetch');
      if (profile && expected !== null && profile.version !== expected) return { ok: false, version: profile.version, data: profile.data };
      profile = { version: (profile?.version || 0) + 1, data };
      return { ok: true, version: profile.version, data };
    }
  };
  return { api, apps, calls, getProfile: () => profile, setProfile: (p: any) => (profile = p) };
}

test('hors ligne : rien n’est perdu, envoi automatique au retour (même après rechargement de la page)', async () => {
  const f = fakeApi(); const st = memoryStorage();
  f.api.online = false;
  const box = new Outbox('u1', f.api, st);
  await box.enqueue({ kind: 'saveApp', id: 'a1', app: { id: 'a1', status: 'prepared' } });
  await box.enqueue({ kind: 'patchApp', id: 'a1', patch: { status: 'applied' } });
  assert.equal(box.state, 'pending');
  assert.equal(box.size, 2);
  // Page rechargée : la file est relue depuis le navigateur
  f.api.online = true;
  const again = new Outbox('u1', f.api, st);
  await again.flush();
  assert.equal(again.state, 'saved');
  assert.deepEqual(f.apps.get('a1'), { id: 'a1', status: 'applied' });
});

test('modifications successives d’un dossier regroupées en une seule requête, champs modifiés seulement', async () => {
  const f = fakeApi();
  f.apps.set('a2', { id: 'a2', status: 'prepared', automation: { state: 'submitted' } });
  f.api.online = false;
  const box = new Outbox('u1', f.api, memoryStorage());
  await box.enqueue({ kind: 'patchApp', id: 'a2', patch: { status: 'applied' } });
  await box.enqueue({ kind: 'patchApp', id: 'a2', patch: { appliedAt: '2026-09-27' } });
  f.api.online = true;
  await box.flush();
  assert.deepEqual(f.calls, ['patch:a2:status,appliedAt']);
  assert.equal(f.apps.get('a2').automation.state, 'submitted', 'champ écrit ailleurs préservé');
});

test('profil modifié sur deux appareils : nos champs réappliqués sur la version la plus récente', async () => {
  const f = fakeApi();
  f.setProfile({ version: 2, data: { fullName: 'Karim', title: 'Dev', skills: ['React', 'Python'] } }); // l'ordinateur a ajouté Python
  const box = new Outbox('u1', f.api, memoryStorage());
  box.profileVersion = 1; // le téléphone connaissait la version 1
  let merged: any = null;
  box.onProfileMerged = (p) => (merged = p);
  const before = { fullName: 'Karim', title: 'Dev', skills: ['React'] };
  const after = { ...before, title: 'Développeur web' };
  await box.enqueue({ kind: 'saveProfile', profile: after, baseVersion: 1, changed: changedKeys(before, after) });
  assert.deepEqual(f.getProfile(), { version: 3, data: { fullName: 'Karim', title: 'Développeur web', skills: ['React', 'Python'] } });
  assert.deepEqual(merged.skills, ['React', 'Python']);
  assert.equal(box.state, 'saved');
});

test('refus définitif du serveur : signalé, les modifications suivantes partent quand même', async () => {
  const f = fakeApi();
  const api = { ...f.api, saveApplication: async (_u: string, app: any) => { if (app.id === 'bad') throw Object.assign(new Error('invalid input'), { code: '22P02' }); return f.api.saveApplication(_u, app); } };
  const box = new Outbox('u1', api, memoryStorage());
  await box.enqueue({ kind: 'saveApp', id: 'bad', app: { id: 'bad' } });
  await box.enqueue({ kind: 'saveApp', id: 'ok', app: { id: 'ok' } });
  assert.ok(f.apps.has('ok'));
  assert.equal(box.size, 0);
  assert.equal(box.state, 'saved', 'état redevenu normal après un envoi réussi');
});

test('état observable : en attente puis enregistré', async () => {
  const f = fakeApi(); f.api.online = false;
  const box = new Outbox('u1', f.api, memoryStorage());
  const states: string[] = [];
  box.subscribe((s) => states.push(s));
  await box.enqueue({ kind: 'deleteApp', id: 'x' });
  f.api.online = true;
  await box.flush();
  assert.deepEqual(states, ['saved', 'pending', 'pending', 'saved']);
});
