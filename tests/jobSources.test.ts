import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLbaJob, normalizeFtJob, romeHints, geocode, searchRealJobs,
  __setFetchForTests, __clearCacheForTests, hasRealSources
} from '../server/jobSources.ts';

const LBA_JOB = {
  identifier: { id: 'abc123', partner_job_id: 'p1', partner_label: 'La bonne alternance' },
  workplace: { name: 'ACME SAS', brand: 'Acme', location: { address: '10 rue X 84000 AVIGNON', geopoint: { type: 'Point', coordinates: [4.81, 43.95] } } },
  apply: { url: 'https://labonnealternance.apprentissage.beta.gouv.fr/emploi/abc123' },
  contract: { type: ['Apprentissage'], remote: 'hybrid' },
  offer: {
    title: 'Développeur web React (alternance)',
    description: 'Vous développerez en React et Node.js avec Git.',
    desired_skills: ['Travailler en équipe'],
    to_be_acquired_skills: [],
    publication: { creation: '2026-09-10T10:00:00.000Z', expiration: '2026-11-10T00:00:00.000Z' },
    status: 'Active'
  }
};

const FT_OFFER = {
  id: '200XYZ',
  intitule: 'Chef de projet informatique H/F',
  description: 'Pilotage de projets SI, méthodologie Agile / Scrum, Jira.',
  dateCreation: '2026-09-15T08:00:00.000Z',
  lieuTravail: { libelle: '84 - AVIGNON', latitude: 43.95, longitude: 4.81 },
  entreprise: { nom: 'Mairie' },
  typeContrat: 'CDI',
  competences: [{ libelle: 'Gestion de projet' }],
  salaire: { libelle: 'Annuel de 38000 Euros' },
  origineOffre: { urlOrigine: 'https://candidat.francetravail.fr/offres/recherche/detail/200XYZ' }
};

beforeEach(() => {
  __clearCacheForTests();
  process.env.ATS_SOURCES = 'off'; // sites carrières : testés dans careerSites.test.ts
  delete process.env.LBA_API_KEY;
  delete process.env.FT_CLIENT_ID;
  delete process.env.FT_CLIENT_SECRET;
});

const res = (status: number, body: any) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test('normalisation La bonne alternance', () => {
  const j = normalizeLbaJob(LBA_JOB)!;
  assert.equal(j.id, 'lba-abc123');
  assert.equal(j.company, 'Acme');
  assert.equal(j.contractType, 'alternance');
  assert.equal(j.remote, 'hybride');
  assert.equal(j.latitude, 43.95);
  assert.equal(j.origin, 'la-bonne-alternance');
  assert.ok(j.skillsRequired.includes('React'));
  assert.ok(j.skillsRequired.includes('Node.js'));
  assert.equal(j.expiresAt, '2026-11-10T00:00:00.000Z');
});

test('normalisation France Travail', () => {
  const j = normalizeFtJob(FT_OFFER)!;
  assert.equal(j.id, 'ft-200XYZ');
  assert.equal(j.contractType, 'cdi');
  assert.equal(j.remote, 'non-precise');
  assert.equal(j.salary, 'Annuel de 38000 Euros');
  assert.ok(j.skillsRequired.includes('Gestion de projet'));
  assert.ok(j.skillsRequired.includes('Méthodologie Agile / Scrum'));
  assert.equal(normalizeFtJob({ ...FT_OFFER, alternance: true })!.contractType, 'alternance');
});

test('codes ROME : développement web oui, développement commercial non', () => {
  assert.deepEqual(romeHints('développeur fullstack'), ['M1805']);
  assert.deepEqual(romeHints('développement commercial'), []);
  assert.ok(romeHints('chef de projet informatique').includes('M1806'));
  assert.deepEqual(romeHints('M1805'), ['M1805']);
});

test('géocodage : commune, département, télétravail', async () => {
  __setFetchForTests(async (url) => {
    assert.match(url, /geo\.api\.gouv\.fr\/communes\?nom=Avignon/);
    return res(200, [{ nom: 'Avignon', code: '84007', codeDepartement: '84', centre: { type: 'Point', coordinates: [4.8, 43.94] } }]);
  });
  assert.deepEqual(await geocode('Avignon'), { label: 'Avignon', latitude: 43.94, longitude: 4.8, inseeCode: '84007', departement: '84' });
  assert.equal((await geocode('84'))?.departement, '84');
  assert.equal(await geocode('Remote'), null);
});

test('recherche combinée : LBA + France Travail, dédoublonnage, jeton mis en cache', async () => {
  process.env.LBA_API_KEY = 'k';
  process.env.FT_CLIENT_ID = 'id';
  process.env.FT_CLIENT_SECRET = 'secret';
  assert.equal(hasRealSources(), true);
  const calls: string[] = [];
  __setFetchForTests(async (url, init) => {
    calls.push(url);
    if (url.includes('geo.api.gouv.fr')) return res(200, [{ nom: 'Avignon', code: '84007', codeDepartement: '84', centre: { coordinates: [4.8, 43.94] } }]);
    if (url.includes('/job/v1/search')) {
      assert.equal(init.headers.Authorization, 'Bearer k');
      assert.match(url, /latitude=43\.94/);
      assert.match(url, /romes=M1805/);
      // la même offre France Travail remonte aussi via LBA → doit être dédoublonnée
      const dup = { ...LBA_JOB, identifier: { ...LBA_JOB.identifier, id: 'dup' }, workplace: { ...LBA_JOB.workplace, brand: 'Mairie', location: { ...LBA_JOB.workplace.location, address: '84 - AVIGNON' } }, offer: { ...LBA_JOB.offer, title: 'Chef de projet informatique H/F' } };
      return res(200, { jobs: [LBA_JOB, dup], recruiters: [], warnings: [] });
    }
    if (url.includes('access_token')) {
      assert.match(String(init.body), /scope=api_offresdemploiv2\+o2dsoffre/);
      return res(200, { access_token: 'tok', expires_in: 1499 });
    }
    if (url.includes('offresdemploi')) {
      assert.equal(init.headers.Authorization, 'Bearer tok');
      assert.match(url, /commune=84007/);
      assert.match(url, /motsCles=developpeur/);
      return res(206, { resultats: [FT_OFFER] });
    }
    throw new Error('URL inattendue ' + url);
  });

  const r = await searchRealJobs({ query: 'développeur', location: 'Avignon', contractType: 'tous' });
  assert.equal(r.resolvedLocation, 'Avignon');
  assert.equal(r.sources.laBonneAlternance.count, 2);
  assert.equal(r.sources.franceTravail.count, 1);
  assert.equal(r.jobs.length, 2, 'doublon retiré');
  assert.equal(r.jobs[0].id, 'ft-200XYZ', 'tri par date décroissante');

  // Deuxième recherche différente : le jeton France Travail est réutilisé
  await searchRealJobs({ query: 'développeur', location: 'Avignon', contractType: 'cdi' });
  assert.equal(calls.filter(u => u.includes('access_token')).length, 1);
});

test('stage : France Travail ignoré avec avertissement ; panne d\'une source signalée', async () => {
  process.env.FT_CLIENT_ID = 'id';
  process.env.FT_CLIENT_SECRET = 'secret';
  __setFetchForTests(async () => { throw new Error('ne doit pas être appelé'); });
  const r1 = await searchRealJobs({ contractType: 'stage' });
  assert.equal(r1.jobs.length, 0);
  assert.ok(r1.warnings.some(w => /stage/i.test(w)));

  process.env.LBA_API_KEY = 'bad';
  __setFetchForTests(async (url) => {
    if (url.includes('/job/v1/search')) return res(401, { message: 'Unauthorized' });
    if (url.includes('access_token')) return res(200, { access_token: 'tok', expires_in: 1499 });
    return res(204, null);
  });
  const r2 = await searchRealJobs({ contractType: 'alternance' });
  assert.match(r2.sources.laBonneAlternance.error || '', /LBA_API_KEY/);
  assert.ok(r2.warnings.some(w => /La bonne alternance indisponible/.test(w)));
  assert.equal(r2.sources.franceTravail.count, 0);
});
