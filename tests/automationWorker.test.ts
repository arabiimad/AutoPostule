import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.AUTOMATION_TOKEN_KEY = 'cle-de-test-pour-les-jetons-de-messagerie';
const { MemoryAutomationStore } = await import('../server/automation/store.ts');
const { runOnce, autoApplicationId } = await import('../server/automation/worker.ts');
const { encryptToken, decryptToken, MailSendError } = await import('../server/automation/email.ts');

const U = 'user-1';
const profile = { fullName: 'Karim Dupont', title: 'Développeur web', skills: ['React', 'TypeScript', 'Node.js'], experiences: [{ title: 'Développeur web', company: 'Studio X', bullets: ['React'] }] };
const offer = (id: string, o: any = {}) => ({
  id, title: 'Développeur React H/F', company: `Entreprise ${id}`, location: 'Avignon', contractType: 'cdi', remote: 'hybride',
  skillsRequired: ['React', 'TypeScript'], description: `Envoyez votre CV à recrutement@${id}.fr`, applyUrl: `https://www.indeed.fr/${id}`, source: 'Test', ...o
});

function setup(opts: { ready?: boolean; send?: (to: string) => Promise<any> } = {}) {
  const store = new MemoryAutomationStore();
  store.policies.set(U, { userId: U, enabled: true, paused: false, roles: ['développeur'], contracts: [], locations: [], remote: [], minSalary: null, minFit: 50, excludedCompanies: [], excludedKeywords: [], channels: ['email', 'form'], dailyLimit: 5, followUps: false });
  store.profiles.set(U, profile);
  store.mail.set(U, { provider: 'gmail', email: 'karim@gmail.com', status: 'active', accessTokenEnc: encryptToken('acces-valide'), refreshTokenEnc: encryptToken('rafraichissement'), expiresAt: new Date(Date.now() + 3600e3).toISOString() });
  const sent: { to: string; token: string; attachments: number }[] = [];
  const refreshed: string[] = [];
  const deps: any = {
    store, workerId: 'w1',
    prepare: async () => ({
      cv: { tailored: { headline: 'Développeur', summary: '', experiences: [], skillsOrder: [], highlights: [] }, analysis: {}, rejected: [], source: 'ai', reviewed: true, far: false, notices: [], models: [] },
      letter: { source: 'ai', letter: 'Madame, Monsieur, …' },
      ready: opts.ready === false ? { ok: false, reasons: ['La lettre contient des éléments absents de votre profil.'] } : { ok: true, reasons: [] }
    }),
    renderCvPdf: async () => Buffer.from('%PDF-1.7 cv'),
    sendMail: async (_p: string, token: string, mail: any) => {
      sent.push({ to: mail.to, token, attachments: mail.attachments.length });
      if (opts.send) return opts.send(mail.to);
      return { provider: 'gmail', messageId: `msg-${sent.length}`, acceptedAt: new Date().toISOString() };
    },
    refreshAccessToken: async (_p: string, rt: string) => { refreshed.push(rt); return { accessToken: 'acces-neuf', expiresAt: new Date(Date.now() + 3600e3).toISOString() }; }
  };
  const drain = async () => { let n = 0; while (await runOnce(deps, { limit: 5 })) if (++n > 20) break; };
  const add = async (o: any) => { store.offers.set(o.id, o); await store.enqueue({ userId: U, kind: 'process_offer', offerId: o.id }); };
  const status = (id: string) => store.tasks.find(t => t.offerId === id)?.status;
  return { store, deps, sent, refreshed, drain, add, status };
}

test('offre avec adresse de candidature : CV et lettre envoyés depuis la boîte du candidat, preuve conservée', async () => {
  const s = setup();
  await s.add(offer('a1'));
  await s.drain();
  assert.deepEqual(s.sent, [{ to: 'recrutement@a1.fr', token: 'acces-valide', attachments: 1 }]);
  const app = s.store.applications.get(`${U}:${autoApplicationId('a1')}`)!;
  assert.equal(app.status, 'applied');
  assert.equal(app.automation.state, 'submitted');
  assert.equal(app.automation.proof.messageId, 'msg-1');
  assert.equal([...s.store.attempts.values()][0].status, 'submitted');
  assert.equal(s.status('a1'), 'done');
});

test('LinkedIn / Indeed sans adresse : aucun envoi, dossier prêt et action demandée', async () => {
  const s = setup();
  await s.add(offer('p1', { description: 'Postulez via le bouton.', applyUrl: 'https://www.linkedin.com/jobs/view/9' }));
  await s.drain();
  assert.equal(s.sent.length, 0);
  assert.equal(s.status('p1'), 'needs_user');
  const app = s.store.applications.get(`${U}:${autoApplicationId('p1')}`)!;
  assert.equal(app.status, 'prepared');
  assert.match(app.automation.reason, /LinkedIn/);
});

test('vérification des documents négative : aucun envoi, validation demandée', async () => {
  const s = setup({ ready: false });
  await s.add(offer('v1'));
  await s.drain();
  assert.equal(s.sent.length, 0);
  assert.equal(s.status('v1'), 'needs_user');
});

test('messagerie non connectée : aucun envoi, connexion demandée', async () => {
  const s = setup();
  s.store.mail.clear();
  await s.add(offer('m1'));
  await s.drain();
  assert.equal(s.sent.length, 0);
  assert.match(s.store.events.at(-1)!.message, /Connectez votre messagerie/);
});

test('pause activée juste avant l’envoi : rien n’est envoyé', async () => {
  const s = setup();
  // Pause activée entre la réservation et l'envoi (autre appareil, par exemple)
  const reserve = s.store.reserveAttempt.bind(s.store);
  s.store.reserveAttempt = async (input: any) => { const r = await reserve(input); s.store.policies.get(U)!.paused = true; return r; };
  await s.add(offer('z1'));
  await s.drain();
  assert.equal(s.sent.length, 0);
  assert.equal([...s.store.attempts.values()][0].status, 'cancelled');
});

test('délai dépassé pendant l’envoi : résultat incertain, jamais renvoyé automatiquement', async () => {
  const s = setup({ send: async () => { throw new Error('The operation was aborted due to timeout'); } });
  await s.add(offer('t1'));
  await s.drain();
  assert.equal(s.sent.length, 1);
  assert.equal(s.status('t1'), 'uncertain');
  // Même offre remise en file (redémarrage, nouvelle recherche) : pas de second envoi
  await s.store.enqueue({ userId: U, kind: 'process_offer', offerId: 't1' });
  await s.drain();
  assert.equal(s.sent.length, 1);
  assert.equal(s.store.applications.get(`${U}:${autoApplicationId('t1')}`)!.automation.state, 'uncertain');
});

test('accès révoqué (401) : connexion marquée révoquée, reprise possible après reconnexion', async () => {
  let fail = true;
  const s = setup({ send: async () => { if (fail) throw new MailSendError('gmail 401', 401, false, true); return { provider: 'gmail', messageId: 'ok', acceptedAt: new Date().toISOString() }; } });
  await s.add(offer('r1'));
  await s.drain();
  assert.equal(s.store.mail.get(U)!.status, 'revoked');
  assert.equal(s.status('r1'), 'needs_user');
  fail = false;
  Object.assign(s.store.mail.get(U)!, { status: 'active' });
  await s.store.enqueue({ userId: U, kind: 'process_offer', offerId: 'r1' });
  await s.drain();
  assert.equal(s.store.applications.get(`${U}:${autoApplicationId('r1')}`)!.status, 'applied');
  assert.equal(s.store.attempts.size, 1, 'une seule tentative pour cette offre');
});

test('limite quotidienne : les envois au-delà sont reportés au lendemain', async () => {
  const s = setup();
  s.store.policies.get(U)!.dailyLimit = 2;
  for (const id of ['d1', 'd2', 'd3']) await s.add(offer(id));
  await s.drain();
  assert.equal(s.sent.length, 2);
  const t = s.store.tasks.find(x => x.offerId === 'd3')!;
  assert.equal(t.status, 'queued');
  assert.ok(t.runAfter > Date.now() + 60_000);
});

test('jeton d’accès expiré : renouvelé puis stocké chiffré', async () => {
  const s = setup();
  s.store.mail.get(U)!.expiresAt = new Date(Date.now() - 1000).toISOString();
  await s.add(offer('e1'));
  await s.drain();
  assert.deepEqual(s.refreshed, ['rafraichissement']);
  assert.equal(s.sent[0].token, 'acces-neuf');
  const enc = s.store.mail.get(U)!.accessTokenEnc!;
  assert.doesNotMatch(enc, /acces-neuf/);
  assert.equal(decryptToken(enc), 'acces-neuf');
});

test('automatisation désactivée : aucune offre traitée', async () => {
  const s = setup();
  s.store.policies.get(U)!.enabled = false;
  await s.add(offer('x1'));
  await s.drain();
  assert.equal(s.sent.length, 0);
  assert.equal(s.status('x1'), 'cancelled');
});

test('recherche planifiée : offres qualifiées ajoutées une seule fois', async () => {
  const s = setup();
  s.deps.searchOffers = async () => [offer('s1'), offer('s2', { title: 'Comptable' }), offer('s1')];
  await s.store.enqueue({ userId: U, kind: 'search' });
  await runOnce(s.deps, { limit: 1 });
  assert.deepEqual(s.store.tasks.filter(t => t.kind === 'process_offer').map(t => t.offerId), ['s1']);
});

// ---------------------------------------------------------------------------
// Formulaires Lever / Greenhouse
// ---------------------------------------------------------------------------
const leverOffer = (id: string) => offer(id, { description: 'Postulez en ligne.', applyUrl: `https://jobs.lever.co/acme/0b5c3a9e-1111-4a2b-9c3d-${id.padStart(12, '0')}` });
function withForm(s: ReturnType<typeof setup>, impl: (answers: Record<string, string>, before: () => Promise<boolean>) => Promise<any>) {
  const calls: any[] = [];
  s.deps.submitForm = async (channel: any, input: any, beforeSubmit: () => Promise<boolean>) => { calls.push({ channel, input }); return impl(input.answers, beforeSubmit); };
  return calls;
}

test('formulaire Lever : envoyé après la dernière vérification, confirmation conservée', async () => {
  const s = setup();
  const calls = withForm(s, async (_a, before) => (await before()) ? { status: 'submitted', proof: { url: 'https://jobs.lever.co/acme/x/thanks', confirmationText: 'Application submitted' } } : { status: 'cancelled', reason: 'pause' });
  await s.add(leverOffer('f1'));
  await s.drain();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.cvPdf.toString().slice(0, 4), '%PDF');
  assert.equal(s.sent.length, 0, 'pas d’email');
  const att = [...s.store.attempts.values()][0];
  assert.deepEqual([att.channel, att.status, att.proof.confirmationText], ['lever', 'submitted', 'Application submitted']);
  assert.equal(s.store.applications.get(`${U}:${autoApplicationId('f1')}`)!.status, 'applied');
});

test('question obligatoire inconnue : posée au candidat, puis envoi une fois la réponse enregistrée', async () => {
  const s = setup();
  withForm(s, async (answers, before) => answers['permis-b']
    ? ((await before()) ? { status: 'submitted', proof: { url: 'u', confirmationText: 'Thank you for applying' } } : { status: 'cancelled', reason: '' })
    : { status: 'needs_user', reason: 'Question « Permis B ? » sans réponse', questions: [{ key: 'permis-b', label: 'Permis B ?' }] });
  await s.add(leverOffer('f2'));
  await s.drain();
  assert.equal(s.status('f2'), 'needs_user');
  assert.ok(s.store.events.some(e => e.type === 'questions' && e.data.questions[0].key === 'permis-b'));
  s.store.answers.set(U, { 'permis-b': 'Oui' });
  await s.store.enqueue({ userId: U, kind: 'process_offer', offerId: 'f2' });
  await s.drain();
  assert.equal(s.store.applications.get(`${U}:${autoApplicationId('f2')}`)!.status, 'applied');
  assert.equal(s.store.attempts.size, 1);
});

test('formulaire : pause au dernier moment → rien n’est soumis', async () => {
  const s = setup();
  let clicked = false;
  withForm(s, async (_a, before) => { s.store.policies.get(U)!.paused = true; if (await before()) clicked = true; return clicked ? { status: 'submitted', proof: { url: '', confirmationText: '' } } : { status: 'cancelled', reason: 'pause' }; });
  await s.add(leverOffer('f3'));
  await s.drain();
  assert.equal(clicked, false);
  assert.equal([...s.store.attempts.values()][0].status, 'cancelled');
});

test('formulaire sans confirmation : incertain, jamais resoumis', async () => {
  const s = setup();
  const calls = withForm(s, async (_a, before) => { await before(); return { status: 'uncertain', reason: 'pas de confirmation' }; });
  await s.add(leverOffer('f4'));
  await s.drain();
  await s.store.enqueue({ userId: U, kind: 'process_offer', offerId: 'f4' });
  await s.drain();
  assert.equal(calls.length, 1);
  assert.deepEqual(s.store.tasks.filter(t => t.offerId === 'f4').map(t => t.status), ['uncertain', 'done']);
});

test('canal formulaire non autorisé par le candidat : dossier prêt, rien n’est soumis', async () => {
  const s = setup();
  s.store.policies.get(U)!.channels = ['email'];
  const calls = withForm(s, async () => ({ status: 'submitted', proof: { url: '', confirmationText: '' } }));
  await s.add(leverOffer('f5'));
  await s.drain();
  assert.equal(calls.length, 0);
  assert.equal(s.status('f5'), 'needs_user');
});
