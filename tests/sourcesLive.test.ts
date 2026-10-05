import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  searchRealJobs, resolveRomes, normalizeLbaRecruiter,
  __setFetchForTests, __clearCacheForTests
} from '../server/jobSources.ts';
import { kv, countApiCall, getQuotaUsage, __resetKvForTests } from '../server/store.ts';

// Formes réelles observées le 23/09/2026 avec de vraies clés (réponses réduites)
const RECRUITER = {
  identifier: { id: 'r1' },
  workplace: {
    siret: '35218860100046', brand: 'MANTIS', name: 'MANTIS', size: '10-19', website: null,
    location: { address: '55 RUE DE RIVOLI 75001 PARIS', geopoint: { coordinates: [2.346, 48.859], type: 'Point' } },
    domain: { naf: { code: '63.11Z', label: 'Traitement de données, hébergement et activités connexes' } }
  },
  apply: { url: 'https://labonnealternance.apprentissage.beta.gouv.fr/emploi/recruteurs_lba/3521886' }
};

const ok = (b: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => b, text: async () => JSON.stringify(b) });
const GEO = [{ nom: 'Avignon', code: '84007', codeDepartement: '84', centre: { coordinates: [4.83, 43.94] } }];

beforeEach(() => {
  __clearCacheForTests();
  process.env.ATS_SOURCES = 'off'; // sites carrières : testés dans careerSites.test.ts
  for (const k of ['LBA_API_KEY', 'FT_CLIENT_ID', 'FT_CLIENT_SECRET', 'JSEARCH_API_KEY', 'ADZUNA_APP_ID', 'ADZUNA_APP_KEY', 'JOOBLE_API_KEY']) delete process.env[k];
});

test('ROME : correspondance métier via La bonne alternance, repli sur les indices locaux', async () => {
  __setFetchForTests(async (url) => {
    assert.match(url, /\/api\/rome\?title=chef%20de%20projet%20informatique/);
    return ok({ labelsAndRomes: [{ label: 'Gestion de projets informatiques', romes: ['I1104', 'M1803', 'M1806'] }] });
  });
  const romes = await resolveRomes('chef de projet informatique');
  assert.deepEqual(romes.slice(0, 2), ['M1806', 'M1805'], 'indices locaux en premier');
  assert.ok(romes.includes('M1803') && romes.includes('I1104'));

  __clearCacheForTests();
  __setFetchForTests(async () => { throw new Error('réseau'); });
  assert.deepEqual(await resolveRomes('développeur'), ['M1805']);
});

test('LBA : entreprises qui recrutent sans offre = candidatures spontanées, après les offres', async () => {
  const r = normalizeLbaRecruiter(RECRUITER, 'développeur web')!;
  assert.equal(r.isSpontaneous, true);
  assert.equal(r.company, 'MANTIS');
  assert.equal(r.contractType, 'alternance');
  assert.equal(r.publishedAt, '', 'aucune date inventée');
  assert.equal(r.companySize, '10-19');
  assert.match(r.title, /Candidature spontanée — Développeur web/);
  assert.deepEqual(r.skillsRequired, []);

  process.env.LBA_API_KEY = 'k';
  __setFetchForTests(async (url) => {
    if (url.includes('geo.api')) return ok(GEO);
    if (url.includes('/api/rome')) return ok({ labelsAndRomes: [] });
    if (url.includes('/job/v1/search')) return ok({ jobs: [], recruiters: [RECRUITER, { ...RECRUITER, identifier: { id: 'r2' }, workplace: { ...RECRUITER.workplace, brand: 'B' } }] });
    throw new Error(url);
  });
  const res = await searchRealJobs({ query: 'développeur web', location: 'Avignon', contractType: 'alternance' });
  assert.equal(res.jobs.length, 2);
  assert.ok(res.jobs.every(j => j.isSpontaneous));

  __clearCacheForTests();
  process.env.LBA_API_KEY = 'k';
  const none = await searchRealJobs({ query: 'développeur web', location: 'Avignon', contractType: 'alternance', includeSpontaneous: false });
  assert.equal(none.jobs.length, 0);
});

test('France Travail : sans résultat par mots-clés, nouvelle tentative par codes ROME', async () => {
  process.env.FT_CLIENT_ID = 'id'; process.env.FT_CLIENT_SECRET = 's';
  const ftCalls: string[] = [];
  __setFetchForTests(async (url) => {
    if (url.includes('geo.api')) return ok(GEO);
    if (url.includes('access_token')) return ok({ access_token: 't', expires_in: 1400 });
    if (url.includes('/api/rome')) return ok({ labelsAndRomes: [{ romes: ['M1806'] }] });
    if (url.includes('offresdemploi')) {
      ftCalls.push(url);
      if (url.includes('motsCles')) return ok(null, 204);
      assert.match(url, /codeROME=M1806/);
      return ok({ resultats: [{ id: '1', intitule: 'Alternance – Ingénieur projet H/F', alternance: true, dateCreation: '2026-09-20T00:00:00Z', lieuTravail: { libelle: '84 - Avignon' }, entreprise: { nom: 'X' } }] }, 206);
    }
    throw new Error(url);
  });
  const r = await searchRealJobs({ query: 'chef de projet informatique', location: 'Avignon', contractType: 'alternance' });
  assert.equal(ftCalls.length, 2);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].contractType, 'alternance');
});

test('Adzuna : mots vides retirés, relance sans « alternance » si rien ; Jooble : lieux étrangers écartés', async () => {
  process.env.ADZUNA_APP_ID = 'i'; process.env.ADZUNA_APP_KEY = 'k'; process.env.JOOBLE_API_KEY = 'j';
  const whats: string[] = [];
  __setFetchForTests(async (url, init) => {
    if (url.includes('geo.api')) return ok([{ nom: 'Paris', code: '75056', codeDepartement: '75', centre: { coordinates: [2.35, 48.86] } }]);
    if (url.includes('adzuna')) {
      const what = new URL(url).searchParams.get('what') || '';
      whats.push(what);
      if (what.includes('alternance')) return ok({ results: [] });
      return ok({ results: [{ id: '1', title: 'Alternance – Développeur web', description: 'Apprentissage', created: '2026-09-22T00:00:00Z', location: { display_name: 'Paris' }, company: { display_name: 'A' }, redirect_url: 'https://adzuna.fr/1' }] });
    }
    if (url.includes('jooble')) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.location, 'Paris, France');
      return ok({ jobs: [
        { id: 'a', title: 'Apprenti développeur web', location: 'Paris, TX', snippet: 'alternance', link: 'https://jooble.org/a', updated: '2026-09-21' },
        { id: 'b', title: 'Apprenti développeur web', location: 'Paris', company: 'B', snippet: 'alternance', link: 'https://jooble.org/b', updated: '2026-09-21' }
      ] });
    }
    throw new Error(url);
  });
  const r = await searchRealJobs({ query: 'développeur de sites web', location: 'Paris', contractType: 'alternance' });
  assert.deepEqual(whats, ['developpeur sites web alternance', 'developpeur sites web']);
  assert.ok(!r.jobs.some(j => /TX/.test(j.location)), 'Paris (Texas) écarté');
  assert.ok(r.jobs.some(j => j.origin === 'adzuna'));
});

test('pagination : page 2 transmise aux sources, La bonne alternance ignorée', async () => {
  process.env.ADZUNA_APP_ID = 'i'; process.env.ADZUNA_APP_KEY = 'k'; process.env.LBA_API_KEY = 'l';
  const urls: string[] = [];
  __setFetchForTests(async (url) => {
    urls.push(url);
    if (url.includes('adzuna')) return ok({ results: Array.from({ length: 50 }, (_, i) => ({ id: String(i), title: `Poste ${i}`, description: 'CDI', created: '2026-09-22T00:00:00Z', location: { display_name: 'Lyon' }, company: { display_name: `C${i}` }, redirect_url: `https://a/${i}` })) });
    throw new Error(url);
  });
  const r = await searchRealJobs({ query: 'comptable', page: 2 });
  assert.equal(r.page, 2);
  assert.equal(r.hasMore, true);
  assert.ok(urls.some(u => /\/search\/2\?/.test(u)));
  assert.ok(r.sources.laBonneAlternance.skipped);
});

test('stockage partagé : compteurs de quota et expiration', async () => {
  __resetKvForTests();
  await countApiCall('jsearch');
  await countApiCall('jsearch');
  const usage = await getQuotaUsage();
  assert.equal(usage.jsearch.used, 2);
  assert.equal(usage.jsearch.limit, 200);
  await kv().set('x', '1', 1);
  assert.equal(await kv().get('x'), '1');
  assert.equal(await kv().incr('n', 60), 1);
  assert.equal(await kv().incr('n', 60), 2);
});

test('caractères Windows-1252 corrigés (France Travail)', async () => {
  const { normalizeFtJob, fixEncoding } = await import('../server/jobSources.ts');
  assert.equal(fixEncoding('Alternance \u0096 Ingenieur Projet'), 'Alternance – Ingenieur Projet');
  assert.equal(normalizeFtJob({ id: '1', intitule: 'Chef de projet \u0096 SI', description: 'l\u0092équipe' })!.title, 'Chef de projet – SI');
});
