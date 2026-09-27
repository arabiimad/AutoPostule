import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAutomationStore, DEFAULT_SETTINGS } from '../server/automation/store.ts';
import { AesGcmCipher, Vault, cipherFromEnv, generatePassword, normalizeSite } from '../server/automation/vault.ts';
import { categorize, questionKey, resolveQuestions } from '../server/automation/answers.ts';
import { checkGuardrails, jobKey, needsApproval, sanitizeSettings } from '../server/automation/guardrails.ts';
import { EmailChannel, ManualChannel, SimulatedMailSender, RetryableError, recruiterEmail, type ApplyChannel } from '../server/automation/channels.ts';
import { MemoryPushSender, Notifier } from '../server/automation/notifier.ts';
import { Orchestrator } from '../server/automation/orchestrator.ts';
import type { AutomationSettings, PreparedDocuments, Submission, Task } from '../server/automation/types.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const profile = {
  fullName: 'Camille Martin',
  email: 'camille@example.com',
  phone: '06 12 34 56 78',
  location: 'Lyon',
  linkedinUrl: 'https://linkedin.com/in/camille',
  languages: ['Français', 'Anglais'],
  experiences: [{ id: 'e1', title: 'Développeuse', company: 'Acme', bullets: ['API Node.js'] }]
};
const job = (over: any = {}) => ({ title: 'Développeur web', company: 'Globex', location: 'Lyon', applyUrl: 'https://globex.example/jobs/1', ...over });
const docs = (pdf = true): PreparedDocuments => ({
  coverLetter: 'Madame, Monsieur, ... lettre',
  latexCode: '\\documentclass{article}',
  ...(pdf ? { cvPdfBase64: Buffer.from('%PDF-1.4').toString('base64') } : {}),
  notices: [],
  preparedAt: new Date().toISOString()
});

function setup(opts: { settings?: Partial<AutomationSettings>; channels?: (mail: SimulatedMailSender) => ApplyChannel[]; pdf?: boolean; ai?: any } = {}) {
  const store = new MemoryAutomationStore();
  store.setProfile('u1', profile);
  const mail = new SimulatedMailSender('camille@example.com');
  const push = new MemoryPushSender();
  const vault = new Vault(store, new AesGcmCipher([KEY]));
  const notifier = new Notifier(store, push, { appUrl: 'https://app.example', digestHours: 12 });
  let prepared = 0;
  const channels = opts.channels ? opts.channels(mail) : [new EmailChannel(async () => mail), new ManualChannel()];
  const orchestrator = new Orchestrator({
    store, vault, notifier, channels, ai: opts.ai,
    prepare: async () => { prepared++; return docs(opts.pdf !== false); }
  });
  if (opts.settings) void store.saveSettings('u1', { ...DEFAULT_SETTINGS, ...opts.settings });
  return { store, mail, push, vault, orchestrator, prepared: () => prepared };
}

async function enqueue(store: MemoryAutomationStore, j = job(), origin: 'user' | 'agent' = 'user') {
  return (await store.queue.enqueue({ uid: 'u1', type: 'apply', dedupeKey: jobKey(j), payload: { job: j, origin } })).task;
}

// ---------------------------------------------------------------------------
// File de tâches
// ---------------------------------------------------------------------------
test('file : une seule candidature par offre (anti-doublon)', async () => {
  const { store } = setup();
  const a = await store.queue.enqueue({ uid: 'u1', type: 'apply', dedupeKey: 'k', payload: { job: job(), origin: 'user' } });
  const b = await store.queue.enqueue({ uid: 'u1', type: 'apply', dedupeKey: 'k', payload: { job: job(), origin: 'user' } });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.task.id, a.task.id);
  // Autre utilisateur : autorisé
  assert.equal((await store.queue.enqueue({ uid: 'u2', type: 'apply', dedupeKey: 'k', payload: { job: job(), origin: 'user' } })).created, true);
});

test('file : une tâche réservée n\'est pas reprise par un autre worker tant que le bail court', async () => {
  const { store } = setup();
  await enqueue(store);
  assert.equal((await store.queue.claim('w1', 10, 60_000)).length, 1);
  assert.equal((await store.queue.claim('w2', 10, 60_000)).length, 0);
});

test('file : bail expiré → reprise par un autre worker, puis échec après le maximum de tentatives', async () => {
  const { store } = setup();
  const t = await enqueue(store);
  for (let i = 1; i <= 3; i++) {
    const claimed = await store.queue.claim(`w${i}`, 10, -1); // bail déjà expiré
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].attempts, i);
  }
  assert.equal((await store.queue.claim('w4', 10, 60_000)).length, 0);
  assert.equal((await store.queue.get(t.id))!.status, 'failed');
});

test('file : seul le worker titulaire du bail peut modifier la tâche', async () => {
  const { store } = setup();
  const t = await enqueue(store);
  await store.queue.claim('w1', 1, 60_000);
  await assert.rejects(store.queue.fail(t.id, 'intrus', 'x', null));
});

test('file : une erreur passagère est retentée plus tard, pas tout de suite', async () => {
  const { store } = setup();
  const t = await enqueue(store);
  await store.queue.claim('w1', 1, 60_000);
  const failed = await store.queue.fail(t.id, 'w1', 'réseau', 5 * 60_000);
  assert.equal(failed.status, 'queued');
  assert.ok(failed.runAt > new Date().toISOString());
  assert.equal((await store.queue.claim('w1', 1, 60_000)).length, 0);
});

// ---------------------------------------------------------------------------
// Coffre
// ---------------------------------------------------------------------------
test('coffre : chiffrement réversible, contexte authentifié, jamais en clair', async () => {
  const c = new AesGcmCipher([KEY]);
  const sealed = c.encrypt('S3cret!', 'u1|site.com');
  assert.ok(!sealed.includes('S3cret'));
  assert.equal(c.decrypt(sealed, 'u1|site.com'), 'S3cret!');
  assert.throws(() => c.decrypt(sealed, 'u2|site.com'));
});

test('coffre : rotation de clé (l\'ancienne clé déchiffre encore)', () => {
  const oldKey = Buffer.alloc(32, 1).toString('base64');
  const sealed = new AesGcmCipher([oldKey]).encrypt('abc', 'ctx');
  assert.equal(new AesGcmCipher([KEY, oldKey]).decrypt(sealed, 'ctx'), 'abc');
});

test('coffre : désactivé en production sans VAULT_KEY ; clé invalide refusée', () => {
  assert.equal(cipherFromEnv({ NODE_ENV: 'production' } as any), null);
  assert.throws(() => cipherFromEnv({ VAULT_KEY: 'trop-courte' } as any));
});

test('coffre : identifiants créés une fois par site, mot de passe fort, liste sans secret', async () => {
  const { vault } = setup();
  const first = await vault.getOrCreate('u1', 'https://www.Acme.wd3.myworkdayjobs.com/fr/careers', 'camille@example.com');
  assert.equal(first.created, true);
  assert.match(first.password, /[A-Z]/);
  assert.match(first.password, /[a-z]/);
  assert.match(first.password, /[0-9]/);
  assert.match(first.password, /[!@#$%*\-_?]/);
  const again = await vault.getOrCreate('u1', 'acme.wd3.myworkdayjobs.com', 'autre');
  assert.equal(again.created, false);
  assert.equal(again.password, first.password);
  const list = await vault.list('u1');
  assert.equal(list.length, 1);
  assert.equal((list[0] as any).secret, undefined);
  assert.equal(list[0].site, 'acme.wd3.myworkdayjobs.com');
  assert.equal(normalizeSite('WWW.Example.com/path'), 'example.com');
  assert.notEqual(generatePassword(), generatePassword());
});

// ---------------------------------------------------------------------------
// Base de réponses
// ---------------------------------------------------------------------------
test('réponses : catégories des questions', () => {
  assert.equal(categorize('Êtes-vous autorisé(e) à travailler en France ?'), 'work_authorization');
  assert.equal(categorize('Quelles sont vos prétentions salariales ?'), 'salary');
  assert.equal(categorize('Date de disponibilité'), 'availability');
  assert.equal(categorize('Êtes-vous en situation de handicap (RQTH) ?'), 'diversity');
  assert.equal(categorize('Adresse email'), 'identity');
  assert.equal(categorize('Pourquoi souhaitez-vous nous rejoindre ?'), 'motivation');
  assert.equal(questionKey('Êtes-vous autorisé à travailler ?'), questionKey('etes vous AUTORISE a travailler'));
});

test('réponses : profil, réponse enregistrée (même formulée autrement), sinon question à l\'utilisateur', async () => {
  const saved = [{ key: questionKey('Quelles sont vos prétentions salariales ?'), label: 'Quelles sont vos prétentions salariales ?', category: 'salary' as const, answer: '38 000 € brut', updatedAt: '' }];
  const { resolved, unresolved } = await resolveQuestions(
    [
      { label: 'Adresse email' },
      { label: 'Numéro de téléphone' },
      { label: 'Prétentions salariales ?' },
      { label: 'Êtes-vous autorisé à travailler en France ?' }
    ],
    { saved, profile }
  );
  assert.deepEqual(resolved.map((r) => [r.answer, r.source]), [['camille@example.com', 'profile'], ['06 12 34 56 78', 'profile'], ['38 000 € brut', 'saved']]);
  assert.deepEqual(unresolved.map((q) => q.category), ['work_authorization']);
});

test('réponses : l\'IA ne répond jamais aux questions sensibles et seulement avec une confiance suffisante', async () => {
  const asked: string[] = [];
  const ai = async (q: any) => {
    asked.push(q.label);
    return q.label.includes('React') ? { answer: '3 ans', confidence: 0.9 } : { answer: 'peut-être', confidence: 0.4 };
  };
  const { resolved, unresolved } = await resolveQuestions(
    [
      { label: "Combien d'années d'expérience avec React ?" },
      { label: 'Pourquoi nous rejoindre ?' },
      { label: 'Quel salaire souhaitez-vous ?' },
      { label: 'Question facultative inconnue', required: false }
    ],
    { saved: [], profile, ai }
  );
  assert.deepEqual(resolved.map((r) => [r.answer, r.source]), [['3 ans', 'ai']]);
  assert.deepEqual(unresolved.map((q) => q.label), ['Pourquoi nous rejoindre ?', 'Quel salaire souhaitez-vous ?']);
  assert.ok(!asked.some((l) => l.includes('salaire')), "le salaire n'est jamais demandé à l'IA");
});

test('réponses : un choix proposé par le formulaire est respecté', async () => {
  const saved = [{ key: questionKey('Permis de conduire ?'), label: 'Permis de conduire ?', category: 'other' as const, answer: 'oui', updatedAt: '' }];
  const { resolved } = await resolveQuestions([{ label: 'Permis de conduire ?', options: ['Oui', 'Non'] }], { saved, profile });
  assert.equal(resolved[0].answer, 'Oui');
});

// ---------------------------------------------------------------------------
// Garde-fous
// ---------------------------------------------------------------------------
const sub = (over: Partial<Submission>): Submission => ({ id: 'x', taskId: 't', jobKey: 'k', company: 'Initech', jobTitle: 'Dev', channel: 'email', submittedAt: new Date().toISOString(), ...over });
const fakeTask = (j: any, origin: 'user' | 'agent' = 'user') => ({ payload: { job: j, origin } }) as Task;

test('garde-fous : entreprise exclue, score trop bas (offres de l\'agent seulement), doublon, même entreprise', () => {
  const s = { ...DEFAULT_SETTINGS, excludedCompanies: ['globex'] };
  assert.equal(checkGuardrails(fakeTask(job({ company: 'Globex SAS' })), s, []).action, 'cancel');
  assert.equal(checkGuardrails(fakeTask(job({ company: 'Hooli', matchScore: 40 }), 'agent'), DEFAULT_SETTINGS, []).action, 'cancel');
  assert.equal(checkGuardrails(fakeTask(job({ company: 'Hooli', matchScore: 40 }), 'user'), DEFAULT_SETTINGS, []).action, 'proceed');
  const j = job({ company: 'Hooli' });
  assert.equal(checkGuardrails(fakeTask(j), DEFAULT_SETTINGS, [sub({ jobKey: jobKey(j), company: 'Autre' })]).action, 'cancel');
  assert.equal(checkGuardrails(fakeTask(job({ company: 'Initech' })), DEFAULT_SETTINGS, [sub({})]).action, 'cancel');
});

test('garde-fous : plafond quotidien → report quand le plus ancien envoi sort de la fenêtre de 24 h', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  const recent = Array.from({ length: 3 }, (_, i) => sub({ company: `C${i}`, jobKey: `k${i}`, submittedAt: new Date(now.getTime() - (10 - i) * 3_600_000).toISOString() }));
  const d = checkGuardrails(fakeTask(job({ company: 'Hooli' })), { ...DEFAULT_SETTINGS, dailyCap: 3 }, recent, now);
  assert.equal(d.action, 'reschedule');
  assert.equal((d as any).runAt, '2026-09-28T02:01:00.000Z');
});

test('garde-fous : niveaux d\'automatisation et réglages bornés', () => {
  assert.equal(needsApproval({ ...DEFAULT_SETTINGS, level: 'manual' }), true);
  assert.equal(needsApproval({ ...DEFAULT_SETTINGS, level: 'rules' }), false);
  assert.equal(needsApproval({ ...DEFAULT_SETTINGS, level: 'progressive', cleanApprovals: 9 }), true);
  assert.equal(needsApproval({ ...DEFAULT_SETTINGS, level: 'progressive', cleanApprovals: 10 }), false);
  const s = sanitizeSettings({ dailyCap: 5000, level: 'n/importe', cleanApprovals: 99 }, DEFAULT_SETTINGS);
  assert.equal(s.dailyCap, 50);
  assert.equal(s.level, 'progressive');
  assert.equal(s.cleanApprovals, 0);
});

test('email du recruteur : champ dédié ou lien mailto', () => {
  assert.equal(recruiterEmail({ contactEmail: 'rh@globex.fr' }), 'rh@globex.fr');
  assert.equal(recruiterEmail({ applyUrl: 'mailto:jobs@globex.fr?subject=x' }), 'jobs@globex.fr');
  assert.equal(recruiterEmail({ applyUrl: 'https://globex.fr' }), null);
});

// ---------------------------------------------------------------------------
// Parcours complets
// ---------------------------------------------------------------------------
test('parcours : validation demandée → notification groupée → validation → envoi par email', async () => {
  const { store, orchestrator, mail, push, prepared } = setup({ settings: { level: 'manual' } });
  await store.saveDeviceToken('u1', 'tel-1');
  const t = await enqueue(store, job({ contactEmail: 'rh@globex.fr' }));

  await orchestrator.tick();
  let task = (await store.queue.get(t.id))!;
  assert.equal(task.status, 'waiting_user');
  assert.equal(task.pending?.kind, 'approve');
  assert.equal(push.sent.length, 1);
  assert.match(push.sent[0].message.title, /attend un tap/);
  assert.equal(mail.outbox.length, 0);

  await orchestrator.resolve('u1', t.id, { action: 'approve' });
  await orchestrator.tick();
  task = (await store.queue.get(t.id))!;
  assert.equal(task.status, 'done');
  assert.equal(task.result?.channel, 'email');
  assert.equal(mail.outbox.length, 1);
  assert.equal(mail.outbox[0].to, 'rh@globex.fr');
  assert.equal(mail.outbox[0].replyTo, 'camille@example.com');
  assert.equal(mail.outbox[0].attachments[0].contentType, 'application/pdf');
  assert.equal(prepared(), 1, 'le dossier n\'est préparé qu\'une fois malgré la reprise');
  assert.equal((await store.getSettings('u1')).cleanApprovals, 1);
  assert.equal((await store.listSubmissionsSince('u1', '2000-01-01')).length, 1);
});

test('parcours : notifications regroupées (une seule pour plusieurs candidatures en attente)', async () => {
  const { store, orchestrator, push } = setup({ settings: { level: 'manual' } });
  await store.saveDeviceToken('u1', 'tel-1');
  await enqueue(store, job({ company: 'A' }));
  await enqueue(store, job({ company: 'B' }));
  await enqueue(store, job({ company: 'C' }));
  await orchestrator.tick();
  assert.equal((await store.queue.listWaiting('u1')).length, 3);
  assert.equal(push.sent.length, 1);
});

test('parcours : lettre corrigée à la validation → envoyée, sans compter pour la confiance progressive', async () => {
  const { store, orchestrator, mail } = setup({ settings: { level: 'progressive' } });
  const t = await enqueue(store, job({ contactEmail: 'rh@globex.fr' }));
  await orchestrator.tick();
  await orchestrator.resolve('u1', t.id, { action: 'approve', coverLetter: 'Ma lettre corrigée' });
  await orchestrator.tick();
  assert.equal(mail.outbox[0].text, 'Ma lettre corrigée');
  assert.equal((await store.getSettings('u1')).cleanApprovals, 0);
});

test('parcours : confiance progressive atteinte → envoi sans validation', async () => {
  const { store, orchestrator, mail } = setup({ settings: { level: 'progressive', cleanApprovals: 10 } });
  const t = await enqueue(store, job({ contactEmail: 'rh@globex.fr' }));
  await orchestrator.tick();
  assert.equal((await store.queue.get(t.id))!.status, 'done');
  assert.equal(mail.outbox.length, 1);
});

test('parcours : refus → annulée, compteur de confiance remis à zéro', async () => {
  const { store, orchestrator } = setup({ settings: { level: 'progressive', cleanApprovals: 4 } });
  const t = await enqueue(store);
  await orchestrator.tick();
  await orchestrator.resolve('u1', t.id, { action: 'reject' });
  assert.equal((await store.queue.get(t.id))!.status, 'cancelled');
  assert.equal((await store.getSettings('u1')).cleanApprovals, 0);
});

test('parcours : pas d\'email ni de PDF → étape manuelle, puis « c\'est envoyé » par l\'utilisateur', async () => {
  const { store, orchestrator } = setup({ settings: { level: 'rules' }, pdf: false });
  const t = await enqueue(store, job({ contactEmail: 'rh@globex.fr' }));
  await orchestrator.tick();
  let task = (await store.queue.get(t.id))!;
  assert.equal(task.pending?.kind, 'manual_step');
  assert.equal(task.pending?.url, 'https://globex.example/jobs/1');
  assert.match(task.pending!.message, /Email au recruteur \(CV PDF indisponible/);
  await orchestrator.resolve('u1', t.id, { action: 'done' });
  await orchestrator.tick();
  task = (await store.queue.get(t.id))!;
  assert.equal(task.status, 'done');
  assert.equal(task.result?.channel, 'manual');
});

test('parcours : questions inconnues → pause, réponses enregistrées et réutilisées sur la candidature suivante', async () => {
  const seen: Record<string, string>[] = [];
  const form: ApplyChannel = {
    id: 'form', label: 'Formulaire test',
    canHandle: () => true,
    async apply(ctx) {
      const { resolved, unresolved } = await ctx.answer([{ label: 'Adresse email' }, { label: 'Êtes-vous autorisé à travailler en France ?' }]);
      if (unresolved.length) return { kind: 'needs_user', pending: { kind: 'question', message: 'Questions sans réponse', questions: unresolved } };
      seen.push(Object.fromEntries(resolved.map((r) => [r.label, r.answer])));
      return { kind: 'submitted', details: {} };
    }
  };
  const { store, orchestrator } = setup({ settings: { level: 'rules' }, channels: () => [form] });
  const t1 = await enqueue(store, job({ company: 'A' }));
  await orchestrator.tick();
  const waiting = (await store.queue.get(t1.id))!;
  assert.equal(waiting.pending?.kind, 'question');
  const key = waiting.pending!.questions![0].key;
  await orchestrator.resolve('u1', t1.id, { action: 'answer', answers: { [key]: 'Oui' } });
  await orchestrator.tick();
  assert.equal((await store.queue.get(t1.id))!.status, 'done');

  // Deuxième offre : même question, plus de pause
  const t2 = await enqueue(store, job({ company: 'B' }));
  await orchestrator.tick();
  assert.equal((await store.queue.get(t2.id))!.status, 'done');
  assert.equal(seen[1]['Êtes-vous autorisé à travailler en France ?'], 'Oui');
});

test('parcours : erreur passagère → nouvelle tentative programmée ; erreur définitive → échec', async () => {
  let calls = 0;
  const flaky: ApplyChannel = {
    id: 'flaky', label: 'Instable', canHandle: () => true,
    async apply() {
      calls++;
      throw calls === 1 ? new RetryableError('site indisponible') : new Error('formulaire illisible');
    }
  };
  const { store, orchestrator } = setup({ settings: { level: 'rules' }, channels: () => [flaky] });
  const t = await enqueue(store);
  await orchestrator.tick();
  let task = (await store.queue.get(t.id))!;
  assert.equal(task.status, 'queued');
  assert.equal(task.lastError, 'site indisponible');
  // On avance l'horloge de la tâche pour la rejouer
  (store.queue as any).tasks.get(t.id).runAt = new Date(0).toISOString();
  await orchestrator.tick();
  task = (await store.queue.get(t.id))!;
  assert.equal(task.status, 'failed');
});

test('parcours : code de vérification → notification immédiate, même juste après une notification groupée', async () => {
  const sms: ApplyChannel = {
    id: 'sms', label: 'Site avec SMS', canHandle: () => true,
    async apply(ctx) {
      if (!ctx.resolution.verificationCode) return { kind: 'needs_user', pending: { kind: 'verification_code', message: 'Code SMS demandé' } };
      return { kind: 'submitted', details: { code: ctx.resolution.verificationCode } };
    }
  };
  const { store, orchestrator, push } = setup({ settings: { level: 'rules' }, channels: () => [sms] });
  await store.saveDeviceToken('u1', 'tel-1');
  await store.acquireNotificationSlot('u1', 'digest', 1000); // notification groupée déjà envoyée
  const t = await enqueue(store);
  await orchestrator.tick();
  assert.equal(push.sent.length, 1);
  assert.match(push.sent[0].message.title, /Code/);
  await orchestrator.resolve('u1', t.id, { action: 'code', code: '123456' });
  await orchestrator.tick();
  assert.equal((await store.queue.get(t.id))!.result?.details.code, '123456');
});

test('parcours : plafond atteint → candidature reportée, pas envoyée', async () => {
  const { store, orchestrator, mail } = setup({ settings: { level: 'rules', dailyCap: 1 } });
  await store.recordSubmission('u1', sub({ company: 'Autre', jobKey: 'autre' }));
  const t = await enqueue(store, job({ contactEmail: 'rh@globex.fr' }));
  await orchestrator.tick();
  const task = (await store.queue.get(t.id))!;
  assert.equal(task.status, 'queued');
  assert.ok(task.runAt > new Date().toISOString());
  assert.equal(task.attempts, 0);
  assert.equal(mail.outbox.length, 0);
});

test('reprise : impossible pour un autre utilisateur ou une tâche qui n\'attend rien', async () => {
  const { store, orchestrator } = setup({ settings: { level: 'manual' } });
  const t = await enqueue(store);
  await assert.rejects(orchestrator.resolve('u1', t.id, { action: 'approve' }), /n'attend pas/);
  await orchestrator.tick();
  await assert.rejects(orchestrator.resolve('u2', t.id, { action: 'approve' }), /introuvable/);
});
