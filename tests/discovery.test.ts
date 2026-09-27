import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boardApiUrl, boardsFromEnv, detectBoard, normalizeBoardJobs, BoardNotFoundError, fetchBoardJobs } from '../server/discovery/atsBoards.ts';
import { buildSearchPlan, canonicalUrl, discoverFromWeb } from '../server/discovery/webDiscovery.ts';
import type { JobOffer } from '../src/types.ts';
import { discoverBeyondJobBoards, knownBoards, learnBoards, titleMatches } from '../server/discovery/discover.ts';
import { isInRegion, locationInRegion } from '../server/discovery/regions.ts';
import { __resetKvForTests } from '../server/store.ts';

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
// Pages carrière et web pour la recherche planifiée (France uniquement)
// ---------------------------------------------------------------------------
const job = (over: Partial<JobOffer>): JobOffer => ({
  id: 'x', title: 'Développeur web', company: 'Acme', location: 'Lyon, France', contractType: 'cdi', remote: 'non-precise',
  description: '', skillsRequired: [], source: 'Site carrière', origin: 'ats', applyUrl: 'https://example.fr', publishedAt: '', status: 'active', ...over
});

test('France : lieux reconnus, sources nationales, publications sans lieu', () => {
  for (const l of ['Paris, France', 'Remote - France', 'Lyon', 'Drancy, IDF, France', 'Saint-Étienne', 'Remote, FR']) assert.equal(locationInRegion(l), true, l);
  for (const l of ['New York, NY', 'Remote, United States', 'London, UK', 'Berlin', 'Singapore']) assert.equal(locationInRegion(l), false, l);
  assert.equal(isInRegion({ location: '38 - VOIRON', origin: 'france-travail' }), true);
  assert.equal(isInRegion({ location: '', origin: 'web-post' }), true);
  assert.equal(isInRegion({ location: '', origin: 'ats' }), false);
});

test('intitulés des pages carrière : tous les mots du métier, féminin compris, tous domaines', () => {
  assert.equal(titleMatches('Senior Backend Software Engineer', 'Backend Engineer'), true);
  assert.equal(titleMatches('Migration Engineer', 'Backend Engineer'), false);
  assert.equal(titleMatches('Développeuse Web H/F', 'Développeur web'), true);
  assert.equal(titleMatches('Aide-soignant(e) de nuit', 'Aide-soignant'), true);
  assert.equal(titleMatches('Comptable', 'Développeur web'), false);
});

test('pages carrière apprises depuis les liens, relues ensuite : métier, contrat, France, ville du candidat', async () => {
  __resetKvForTests();
  assert.equal(await learnBoards(['https://jobs.lever.co/acme/123', 'https://www.indeed.fr/x', 'https://jobs.lever.co/acme/456']), 1);
  assert.equal(await learnBoards(['https://jobs.lever.co/acme/789']), 0);
  assert.deepEqual((await knownBoards()).map((b) => b.token), ['acme']);
  const r = await discoverBeyondJobBoards({ roles: ['Développeur web'], locations: ['Lyon'], contract: 'cdi' }, {
    fetchBoard: async () => [
      job({ id: 'ok' }),
      job({ id: 'paris', location: 'Paris, France' }),
      job({ id: 'teletravail', location: 'Remote - France', remote: 'total' }),
      job({ id: 'usa', location: 'New York, NY', remote: 'total' }),
      job({ id: 'metier', title: 'Comptable' }),
      job({ id: 'stage', contractType: 'stage' })
    ]
  });
  assert.deepEqual(r.jobs.map((j) => j.id).sort(), ['ok', 'teletravail']);
  assert.equal(r.bySource['pages carrière'], 2);
});

test('web : publications « on recrute » ajoutées, pages carrière citées apprises, lieu par défaut France', async () => {
  __resetKvForTests();
  let prompt = '';
  const r = await discoverBeyondJobBoards({ roles: ['Boulanger'], locations: [], contract: 'tous' }, {
    webSearch: async (p) => {
      prompt = p;
      return {
        text: JSON.stringify([{ title: 'Boulanger', company: 'Maison Dupain', kind: 'post', url: 'https://www.linkedin.com/posts/dupain_1', excerpt: 'On recrute un boulanger ! CV à recrutement@dupain.fr' }]),
        sources: [{ uri: 'https://www.linkedin.com/posts/dupain_1' }, { uri: 'https://boards.greenhouse.io/boulangeries/jobs/1' }]
      };
    },
    fetchBoard: async () => []
  });
  assert.match(prompt, /Boulanger/);
  assert.match(prompt, /France/);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].contactEmail, 'recrutement@dupain.fr');
  assert.deepEqual((await knownBoards()).map((b) => b.token), ['boulangeries']);
});

test('une source en panne n\'empêche pas les autres', async () => {
  __resetKvForTests();
  await learnBoards(['https://jobs.lever.co/acme/1']);
  const r = await discoverBeyondJobBoards({ roles: ['Développeur web'], locations: [], contract: 'tous' }, {
    webSearch: async () => { throw new Error('quota'); },
    fetchBoard: async () => [job({ id: 'ok' })]
  });
  assert.equal(r.jobs.length, 1);
  assert.ok(r.errors.some((e) => e.includes('quota')));
});
