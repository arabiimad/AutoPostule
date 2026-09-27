import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.AUTOMATION_TOKEN_KEY = 'cle-de-test-pour-les-jetons-de-messagerie';
const { MemoryAutomationStore } = await import('../server/automation/store.ts');
const { runOnce, autoApplicationId } = await import('../server/automation/worker.ts');
const { resolveApplyChannel, isAutomatable } = await import('../server/automation/channels.ts');
const { applyViaLba, lbaMissingFields, normalizePhone } = await import('../server/automation/lba.ts');
const { qualifyOffer } = await import('../server/automation/policy.ts');

const U = 'user-1';
const profile = { fullName: 'Karim Dupont', email: 'karim@gmail.com', phone: '+33 6 12 34 56 78', title: 'Développeur web', skills: ['React', 'TypeScript'], experiences: [{ title: 'Développeur web', company: 'Studio X', bullets: ['React'] }] };
const lbaOffer = (id: string, o: any = {}) => ({
  id, title: 'Alternance développeur React', company: `Entreprise ${id}`, location: 'Avignon', contractType: 'alternance', remote: 'sur-site',
  skillsRequired: ['React'], description: 'Alternance', applyUrl: 'https://labonnealternance.apprentissage.beta.gouv.fr/x', lbaRecipientId: `rcpt-${id}`, source: 'La bonne alternance', ...o
});
const json = (status: number, body: any) => ({ ok: status < 300, status, json: async () => body });

function setup(applyLba?: (input: any) => Promise<any>) {
  const store = new MemoryAutomationStore();
  store.policies.set(U, { userId: U, enabled: true, paused: false, roles: ['développeur'], contracts: [], locations: [], remote: [], minSalary: null, minFit: 50, excludedCompanies: [], excludedKeywords: [], channels: ['email'], dailyLimit: 5, followUps: false });
  store.profiles.set(U, profile);
  const calls: any[] = [];
  const deps: any = {
    store, workerId: 'w1',
    prepare: async () => ({
      cv: { tailored: { headline: '', summary: '', experiences: [], skillsOrder: [], highlights: [] }, analysis: {}, rejected: [], source: 'ai', reviewed: true, far: false, notices: [], models: [] },
      letter: { source: 'ai', letter: 'Madame, Monsieur, …' },
      ready: { ok: true, reasons: [] }
    }),
    renderCvPdf: async () => Buffer.from('%PDF-1.7 cv'),
    sendMail: async () => { throw new Error('ne doit pas envoyer d’email'); },
    refreshAccessToken: async () => ({ accessToken: 'x', expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
    ...(applyLba ? { applyLba: async (input: any) => { calls.push(input); return applyLba(input); } } : {})
  };
  const drain = async () => { let n = 0; while (await runOnce(deps, { limit: 5 })) if (++n > 20) break; };
  const add = async (o: any) => { store.offers.set(o.id, o); await store.enqueue({ userId: U, kind: 'process_offer', offerId: o.id }); };
  const status = (id: string) => store.tasks.find((t) => t.offerId === id)?.status;
  return { store, calls, drain, add, status };
}

test('canal : La bonne alternance prioritaire, puis adresse fournie par la source (France Travail)', () => {
  const lba = resolveApplyChannel(lbaOffer('a'));
  assert.equal(lba.kind, 'lba');
  assert.equal(isAutomatable(lba, ['email']), true);
  assert.equal(isAutomatable(lba, ['form']), false);
  const ft = resolveApplyChannel({ applyUrl: 'https://candidat.francetravail.fr/offres/1', contactEmail: 'RH@Garage-Martin.fr', source: 'France Travail' });
  assert.deepEqual([ft.kind, ft.target], ['email', 'rh@garage-martin.fr']);
  assert.equal(resolveApplyChannel({ applyUrl: 'https://candidat.francetravail.fr/offres/1', contactEmail: 'noreply@x.fr' }).kind, 'platform');
  // Formulaire Lever reconnu : reste prioritaire
  assert.equal(resolveApplyChannel({ applyUrl: 'https://jobs.lever.co/acme/6ed76ce8-4156-4b60-b120-403538bd66cd', lbaRecipientId: 'r' }).kind, 'lever');
});

test('La bonne alternance : candidature transmise, preuve conservée, dossier « envoyé »', async () => {
  const s = setup(async () => ({ status: 'submitted', id: 'app-42' }));
  await s.add(lbaOffer('l1'));
  await s.drain();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].recipientId, 'rcpt-l1');
  assert.equal(s.calls[0].email, 'karim@gmail.com');
  assert.equal(s.calls[0].letter, 'Madame, Monsieur, …');
  const app = s.store.applications.get(`${U}:${autoApplicationId('l1')}`)!;
  assert.equal(app.status, 'applied');
  assert.equal(app.automation.channel, 'lba');
  assert.equal(app.automation.proof.applicationId, 'app-42');
  const attempt = [...s.store.attempts.values()][0];
  assert.deepEqual([attempt.channel, attempt.status], ['lba', 'submitted']);
  assert.equal(s.status('l1'), 'done');
});

test('La bonne alternance : sans réponse → résultat incertain, jamais renvoyé ; limite → nouvel essai ; refus → action du candidat', async () => {
  const unsure = setup(async () => ({ status: 'uncertain', reason: 'délai dépassé' }));
  await unsure.add(lbaOffer('u1'));
  await unsure.drain();
  assert.equal(unsure.status('u1'), 'uncertain');
  assert.equal([...unsure.store.attempts.values()][0].status, 'uncertain');

  const limited = setup(async () => ({ status: 'retry', reason: 'Limite atteinte.' }));
  await limited.add(lbaOffer('r1'));
  await limited.drain();
  assert.equal(limited.status('r1'), 'queued');
  assert.equal([...limited.store.attempts.values()][0].status, 'failed', 'rien n’est parti : la tentative peut être reprise');

  const refused = setup(async () => ({ status: 'refused', reason: 'Offre fermée.' }));
  await refused.add(lbaOffer('x1'));
  await refused.drain();
  assert.equal(refused.status('x1'), 'needs_user');
});

test('La bonne alternance : profil incomplet ou service non configuré → dossier prêt, action demandée', async () => {
  const s = setup(async () => ({ status: 'submitted', id: 'x' }));
  s.store.profiles.set(U, { ...profile, phone: '' });
  await s.add(lbaOffer('p1'));
  await s.drain();
  assert.equal(s.calls.length, 0);
  assert.equal(s.status('p1'), 'needs_user');
  assert.match(s.store.applications.get(`${U}:${autoApplicationId('p1')}`)!.automation.reason, /téléphone/);

  const off = setup();
  await off.add(lbaOffer('n1'));
  await off.drain();
  assert.equal(off.status('n1'), 'needs_user');
});

test('API La bonne alternance : requête conforme à la documentation (POST /job/v1/apply)', async () => {
  let call: any;
  const r = await applyViaLba(
    { recipientId: 'rcpt-9', fullName: 'Karim Ben Dupont', email: 'karim@gmail.com', phone: '06.12.34.56.78', cvPdf: Buffer.from('%PDF'), cvFileName: 'CV - Karim.pdf', letter: 'Bonjour' },
    { apiKey: 'cle', baseUrl: 'https://lba.test/api', fetch: async (url, init) => { call = { url, headers: init.headers, body: JSON.parse(init.body) }; return json(202, { id: 'app-1' }); } }
  );
  assert.deepEqual(r, { status: 'submitted', id: 'app-1' });
  assert.equal(call.url, 'https://lba.test/api/job/v1/apply');
  assert.equal(call.headers.Authorization, 'Bearer cle');
  assert.deepEqual(call.body, {
    applicant_first_name: 'Karim', applicant_last_name: 'Ben Dupont', applicant_email: 'karim@gmail.com', applicant_phone: '0612345678',
    applicant_attachment_name: 'CV - Karim.pdf', applicant_attachment_content: Buffer.from('%PDF').toString('base64'), applicant_message: 'Bonjour', recipient_id: 'rcpt-9'
  });
  const input = { recipientId: 'r', fullName: 'A B', email: 'a@b.fr', phone: '0600000000', cvPdf: Buffer.from(''), cvFileName: 'cv.pdf', letter: '' };
  assert.equal((await applyViaLba(input, { apiKey: 'k', fetch: async () => json(429, {}) })).status, 'retry');
  assert.equal((await applyViaLba(input, { apiKey: 'k', fetch: async () => json(403, {}) })).status, 'refused');
  assert.equal((await applyViaLba(input, { apiKey: 'k', fetch: async () => json(400, { message: 'recipient inconnu' }) })).status, 'refused');
  assert.equal((await applyViaLba(input, { apiKey: 'k', fetch: async () => { const e: any = new Error('t'); e.name = 'TimeoutError'; throw e; } })).status, 'uncertain');
  assert.equal((await applyViaLba(input, { apiKey: 'k', fetch: async () => { throw new TypeError('fetch failed'); } })).status, 'retry');
  assert.equal(normalizePhone('+33 6 12 34 56 78'), '0612345678');
  assert.match(lbaMissingFields({ fullName: 'Karim', email: '' })!, /nom, email, téléphone/);
});

test('recherche : une alternance La bonne alternance reste qualifiable (pas une candidature spontanée)', () => {
  const policy = { userId: U, enabled: true, paused: false, roles: ['développeur'], contracts: [], locations: [], remote: [], minSalary: null, minFit: 50, excludedCompanies: [], excludedKeywords: [], channels: ['email'], dailyLimit: 5, followUps: false };
  assert.equal(qualifyOffer(policy, profile, lbaOffer('q')).ok, true);
});
