import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boardApiUrl, boardsFromEnv, detectBoard, normalizeBoardJobs, BoardNotFoundError, fetchBoardJobs } from '../server/discovery/atsBoards.ts';
import { buildSearchPlan, canonicalUrl, discoverFromWeb } from '../server/discovery/webDiscovery.ts';
import { DiscoveryService, isAutoApplicable, profileQueries, titleMatches } from '../server/discovery/discover.ts';
import { MemoryAutomationStore } from '../server/automation/store.ts';
import type { JobOffer } from '../src/types.ts';

const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/ats/${name}.json`, import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------
// Pages carrière (formats réels enregistrés en septembre 2026)
// ---------------------------------------------------------------------------
test('pages carrière : reconnaissance des liens d\'offres', () => {
  assert.deepEqual(detectBoard('https://boards.greenhouse.io/acme/jobs/123'), { ats: 'greenhouse', token: 'acme' });
  assert.deepEqual(detectBoard('https://job-boards.greenhouse.io/gitlab/jobs/8556658002'), { ats: 'greenhouse', token: 'gitlab' });
  assert.deepEqual(detectBoard('https://boards.greenhouse.io/embed/job_board?for=globex'), { ats: 'greenhouse', token: 'globex' });
  assert.deepEqual(detectBoard('https://jobs.lever.co/palantir/6ed76ce8'), { ats: 'lever', token: 'palantir' });
  assert.deepEqual(detectBoard('https://jobs.eu.lever.co/mistral/x'), { ats: 'lever', token: 'mistral', region: 'eu' });
  assert.deepEqual(detectBoard('https://jobs.ashbyhq.com/ramp/34413f8d'), { ats: 'ashby', token: 'ramp' });
  assert.deepEqual(detectBoard('https://jobs.smartrecruiters.com/BoschGroup/744000151788506'), { ats: 'smartrecruiters', token: 'BoschGroup' });
  assert.equal(detectBoard('https://www.linkedin.com/jobs/view/1'), null);
  assert.equal(detectBoard('pas une url'), null);
  assert.deepEqual(boardsFromEnv('greenhouse:acme, lever:globex, inconnu:x'), [{ ats: 'greenhouse', token: 'acme' }, { ats: 'lever', token: 'globex' }]);
  assert.match(boardApiUrl({ ats: 'lever', token: 'mistral', region: 'eu' }), /^https:\/\/api\.eu\.lever\.co\/v0\/postings\/mistral/);
});

test('pages carrière : Greenhouse (contenu HTML échappé décodé, télétravail déduit du lieu)', () => {
  const [o] = normalizeBoardJobs({ ats: 'greenhouse', token: 'gitlab' }, fixture('greenhouse'));
  assert.equal(o.title, 'AI Engineer');
  assert.equal(o.company, 'GitLab');
  assert.equal(o.remote, 'total');
  assert.equal(o.origin, 'ats');
  assert.match(o.applyUrl, /^https:\/\/job-boards\.greenhouse\.io\/gitlab\/jobs\//);
  assert.ok(!/&lt;|<div/.test(o.description), 'HTML retiré');
  assert.ok(o.publishedAt.startsWith('2026-'));
});

test('pages carrière : Lever, Ashby, SmartRecruiters', () => {
  const [l] = normalizeBoardJobs({ ats: 'lever', token: 'palantir' }, fixture('lever'));
  assert.equal(l.company, 'Palantir');
  assert.equal(l.remote, 'hybride');
  assert.match(l.applyUrl, /^https:\/\/jobs\.lever\.co\/palantir\/[0-9a-f-]+$/);

  const [a] = normalizeBoardJobs({ ats: 'ashby', token: 'ramp' }, fixture('ashby'));
  assert.equal(a.title, 'Security Engineer, Cloud');
  assert.ok(a.salary);
  assert.match(a.applyUrl, /^https:\/\/jobs\.ashbyhq\.com\/ramp\//);

  const [s] = normalizeBoardJobs({ ats: 'smartrecruiters', token: 'BoschGroup' }, fixture('smartrecruiters'));
  assert.equal(s.company, 'Bosch Group');
  assert.match(s.location, /France/);
  assert.equal(s.remote, 'hybride');
  assert.equal(s.descriptionIsSnippet, true);
  assert.match(s.applyUrl, /^https:\/\/jobs\.smartrecruiters\.com\/BoschGroup\/\d+$/);
});

test('pages carrière : page supprimée signalée à part (pas une erreur de recherche)', async () => {
  await assert.rejects(fetchBoardJobs({ ats: 'lever', token: 'disparu' }, async () => ({ ok: false, status: 404, json: async () => ({}) })), BoardNotFoundError);
});

// ---------------------------------------------------------------------------
// Web public : publications « on recrute »
// ---------------------------------------------------------------------------
test('web : plan de recherche (publications LinkedIn, annonces, pages carrière)', () => {
  const plan = buildSearchPlan({ role: 'Développeur web', location: 'Lyon', contract: 'alternance' });
  assert.match(plan[0], /^site:linkedin\.com\/posts .*"on recrute".*"Développeur web" alternance Lyon/);
  assert.ok(plan.some((p) => p.includes('site:jobs.lever.co')));
  assert.equal(canonicalUrl('https://fr.linkedin.com/posts/acme_on-recrute-123/?utm_source=x&trk=y'), 'linkedin.com/posts/acme_on-recrute-123');
});

test('web : seules les offres dont le lien a réellement été consulté sont gardées', async () => {
  const now = new Date('2026-09-27T10:00:00Z');
  const search = async () => ({
    text: JSON.stringify([
      { title: 'Développeur web', company: 'Acme', location: 'Lyon', kind: 'post', url: 'https://www.linkedin.com/posts/acme_on-recrute-123', excerpt: '🚀 On recrute un développeur web à Lyon ! CV à jobs@acme.fr', publishedAt: '2026-09-20' },
      { title: 'Développeur React', company: 'Globex', kind: 'job', url: 'https://globex.fr/carrieres/react', excerpt: 'Nous recrutons', publishedAt: '' },
      { title: 'Offre inventée', company: 'Fantôme', kind: 'job', url: 'https://inexistant.example/offre', excerpt: '' },
      { title: 'Vieille publication', company: 'Old', kind: 'post', url: 'https://www.linkedin.com/posts/old_1', publishedAt: '2026-05-01' }
    ]),
    sources: [
      { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA' },
      { uri: 'https://globex.fr/carrieres/react' },
      { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB' }
    ]
  });
  const redirects: Record<string, string> = {
    'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA': 'https://fr.linkedin.com/posts/acme_on-recrute-123?trk=public',
    'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB': 'https://www.linkedin.com/posts/old_1'
  };
  const r = await discoverFromWeb(search, { role: 'Développeur web', location: 'Lyon' }, { resolveUrl: async (u) => redirects[u] || u, now });
  assert.deepEqual(r.offers.map((o) => o.company), ['Acme', 'Globex']);
  assert.equal(r.rejected, 2);
  const post = r.offers[0];
  assert.equal(post.isPost, true);
  assert.equal(post.origin, 'web-post');
  assert.equal(post.source, 'Publication LinkedIn (à vérifier)');
  assert.equal(post.contactEmail, 'jobs@acme.fr');
  assert.equal(post.applyUrl, 'https://fr.linkedin.com/posts/acme_on-recrute-123?trk=public');
  assert.equal(r.offers[1].origin, 'web');
});

test('web : réponse illisible → aucune offre, sans erreur', async () => {
  const r = await discoverFromWeb(async () => ({ text: 'Désolé, rien trouvé.', sources: [] }), { role: 'x' });
  assert.equal(r.offers.length, 0);
});

// ---------------------------------------------------------------------------
// Découverte pour un utilisateur
// ---------------------------------------------------------------------------
const job = (over: Partial<JobOffer>): JobOffer => ({
  id: 'x', title: 'Développeur web', company: 'Acme', location: 'Lyon', contractType: 'cdi', remote: 'non-precise',
  description: 'Développement React et Node.js', skillsRequired: ['React', 'Node.js'], source: 'France Travail',
  origin: 'france-travail', applyUrl: 'https://example.fr/offre', publishedAt: '2026-09-20', status: 'active', ...over
});

const profile = {
  fullName: 'Camille Martin', title: 'Développeuse web', targetRoles: ['Développeur web'], location: 'Lyon',
  preferredContracts: ['cdi'], skills: ['React', 'Node.js', 'TypeScript'], autoApplyEnabled: true
};

test('découverte : recherches tirées du profil', () => {
  assert.deepEqual(profileQueries(profile), { roles: ['Développeur web'], location: 'Lyon', contract: 'cdi' });
  assert.deepEqual(profileQueries({ targetRoles: ['Data analyst', 'Comptable'], title: 'Data Analyst' }).roles, ['Data analyst', 'Comptable']);
  assert.equal(profileQueries({}).roles.length, 0);
});

test('découverte : toutes les sources fusionnées, notées, listées ; pages carrière apprises ; candidature auto si possible', async () => {
  const store = new MemoryAutomationStore();
  const searched: any[] = [];
  const svc = new DiscoveryService({
    store,
    searchJobs: async (p) => {
      searched.push(p);
      return {
        jobs: [
          job({ id: 'ft1', company: 'Acme', contactEmail: 'rh@acme.fr' }),
          job({ id: 'js1', company: 'Globex', title: 'Développeur web', skillsRequired: ['PHP', 'Symfony'], applyUrl: 'https://jobs.lever.co/globex/abc', origin: 'jsearch', source: 'Google Jobs' })
        ],
        sources: {} as any, warnings: []
      };
    },
    webSearch: async () => ({
      text: JSON.stringify([{ title: 'Développeur web', company: 'Initech', location: 'Lyon', kind: 'post', url: 'https://www.linkedin.com/posts/initech_1', excerpt: 'On recrute ! Écrivez à talents@initech.fr' }]),
      sources: [{ uri: 'https://www.linkedin.com/posts/initech_1' }]
    }),
    fetchBoard: async (b) => (b.token === 'globex'
      ? [job({ id: 'b1', company: 'Globex', title: 'Développeur web senior', location: 'Lyon, France', origin: 'ats' }), job({ id: 'b2', company: 'Globex', title: 'Comptable', location: 'Lyon' }), job({ id: 'b3', company: 'Globex', title: 'Développeur web', location: 'Berlin' })]
      : [])
  });

  const enqueued: string[] = [];
  const run = await svc.run('u1', profile, { minScore: 60, enqueue: async (_u, j) => { enqueued.push(j.company); return `t-${j.company}`; } });
  assert.equal(searched[0].query, 'Développeur web');
  assert.equal(searched[0].location, 'Lyon');
  assert.equal(run.bySource['pages carrière'], 1, 'Comptable (hors poste) et Berlin (hors lieu) écartés');
  assert.equal(run.bySource['web et publications'], 1);
  assert.deepEqual((await store.listBoards(10)).map((b) => b.id), ['lever:globex']);

  const offers = await store.listOffers('u1');
  const byCompany = Object.fromEntries(offers.map((o) => [`${o.job.company}|${o.job.title}`, o]));
  assert.equal(byCompany['Acme|Développeur web'].score, 100);
  assert.equal(byCompany['Globex|Développeur web'].score, 0);
  assert.equal(byCompany['Initech|Développeur web'].job.isPost, true);

  // Seule l'offre compatible avec un canal automatique (email du recruteur) part en file
  assert.deepEqual(enqueued, ['Acme']);
  assert.equal(run.queued, 1);
  assert.equal(byCompany['Acme|Développeur web'].status, 'queued');

  // Deuxième passage : pas de doublon, statut conservé
  const again = await svc.run('u1', profile, { minScore: 60, enqueue: async () => 'nouveau' });
  assert.equal(again.added, 0);
  assert.equal((await store.listOffers('u1')).length, offers.length);
  assert.equal(again.queued, 0);
});

test('découverte : pas de candidature automatique si l\'utilisateur ne l\'a pas activée', async () => {
  const store = new MemoryAutomationStore();
  const svc = new DiscoveryService({ store, searchJobs: async () => ({ jobs: [job({ contactEmail: 'rh@acme.fr' })], sources: {} as any, warnings: [] }) });
  let called = false;
  const run = await svc.run('u1', { ...profile, autoApplyEnabled: false }, { enqueue: async () => { called = true; return 't'; } });
  assert.equal(called, false);
  assert.equal(run.queued, 0);
  assert.equal(run.found, 1);
});

test('découverte : correspondance stricte des intitulés des pages carrière', () => {
  assert.equal(titleMatches('Senior Backend Software Engineer', 'Backend Engineer'), true);
  assert.equal(titleMatches('Migration Engineer - GitLab Dedicated', 'Backend Engineer'), false);
  assert.equal(titleMatches('Développeuse Web H/F', 'Développeur web'), true);
  assert.equal(titleMatches('Comptable', 'Développeur web'), false);
});

test('découverte : canaux automatiques', () => {
  assert.equal(isAutoApplicable({ contactEmail: 'a@b.fr' }), true);
  assert.equal(isAutoApplicable({ lbaRecipientId: 'x' }), true);
  assert.equal(isAutoApplicable({ applyUrl: 'https://x' }), false);
});

test('découverte : une source en panne n\'empêche pas les autres', async () => {
  const store = new MemoryAutomationStore();
  const svc = new DiscoveryService({
    store,
    searchJobs: async () => { throw new Error('réseau'); },
    webSearch: async () => ({ text: JSON.stringify([{ title: 'Développeur web', company: 'Initech', kind: 'post', url: 'https://x.fr/p' }]), sources: [{ uri: 'https://x.fr/p' }] })
  });
  const run = await svc.run('u1', profile);
  assert.equal(run.found, 1);
  assert.ok(run.errors.some((e) => e.includes('réseau')));
});

test('France uniquement : offres hors de France écartées', async () => {
  const { isInRegion } = await import('../server/discovery/regions.ts');
  assert.equal(isInRegion({ location: 'Paris, France', origin: 'ats' }), true);
  assert.equal(isInRegion({ location: 'New York, NY', origin: 'ats' }), false);
  assert.equal(isInRegion({ location: '38 - VOIRON', origin: 'france-travail' }), true);
  assert.equal(isInRegion({ location: '', origin: 'web-post' }), true);
  const store = new MemoryAutomationStore();
  const svc = new DiscoveryService({ store, fetchBoard: async () => [job({ id: 'fr1', title: 'Développeur web', location: 'Lyon, France', origin: 'ats' }), job({ id: 'de1', title: 'Développeur web', company: 'Globex', location: 'Berlin, Germany', origin: 'ats' })] });
  await store.saveBoards([{ id: 'lever:x', ats: 'lever', token: 'x' }]);
  const run = await svc.run('u1', { ...profile, location: '' });
  assert.equal(run.found, 1);
});
