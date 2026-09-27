import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { searchRealJobs, setOfferIndex, normalizeFtJob, __setFetchForTests, __clearCacheForTests } from '../server/jobSources.ts';
import { buildIndexQuery, PgOfferSearch } from '../server/ingest/offerSearch.ts';
import { PgOfferStore, toOfferRow } from '../server/ingest/offerStore.ts';

const res = (status: number, body: any) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });

after(() => setOfferIndex(null));

test('recherche : la partie France Travail vient de la base quand elle répond, sans appel à l\'API', async () => {
  __clearCacheForTests();
  process.env.FT_CLIENT_ID = 'id';
  process.env.FT_CLIENT_SECRET = 'secret';
  delete process.env.LBA_API_KEY; delete process.env.JSEARCH_API_KEY; delete process.env.ADZUNA_APP_ID; delete process.env.JOOBLE_API_KEY;
  const ftCalls: string[] = [];
  __setFetchForTests(async (url) => {
    if (url.includes('geo.api.gouv.fr')) return res(200, [{ nom: 'Avignon', code: '84007', codeDepartement: '84', centre: { coordinates: [4.8, 43.94] } }]);
    if (url.includes('access_token')) return res(200, { access_token: 'tok', expires_in: 1499 });
    if (url.includes('offresdemploi')) { ftCalls.push(url); return res(200, { resultats: [{ id: 'LIVE', intitule: 'Aide-soignant (API)', lieuTravail: { libelle: '84 - Avignon' }, dateCreation: '2026-09-20T10:00:00Z' }] }); }
    return res(200, []);
  });
  const indexed = normalizeFtJob({ id: 'IDX', intitule: 'Aide-soignant (base)', lieuTravail: { libelle: '84 - Avignon' }, dateCreation: '2026-09-21T10:00:00Z' })!;
  let received: any = null;
  setOfferIndex(async (params, geo) => { received = { params, geo }; return { jobs: [indexed], full: false }; });

  const r = await searchRealJobs({ query: 'aide-soignant', location: 'Avignon', contractType: 'tous' });
  assert.deepEqual(r.jobs.map((j) => j.id), ['ft-IDX']);
  assert.equal(r.sources.franceTravail.via, 'base');
  assert.equal(ftCalls.length, 0, 'aucun appel à l\'API France Travail');
  assert.equal(received.geo.departement, '84');

  // Base indisponible (null) : repli automatique sur l'API
  setOfferIndex(async () => null);
  __clearCacheForTests();
  const r2 = await searchRealJobs({ query: 'aide-soignant', location: 'Avignon', contractType: 'tous' });
  assert.deepEqual(r2.jobs.map((j) => j.id), ['ft-LIVE']);
  assert.equal(r2.sources.franceTravail.via, undefined);
  assert.equal(ftCalls.length, 1);
});

test('requête SQL : mots-clés, contrat, rayon ou département, pagination', () => {
  const a = buildIndexQuery({ query: 'aide soignant', contractType: 'cdi', radius: 20, page: 2 }, { label: 'Avignon', latitude: 43.9, longitude: 4.8, departement: '84' }, 'France Travail', null);
  assert.match(a.sql, /plainto_tsquery\('french'/);
  assert.match(a.sql, /contract = \$3/);
  assert.match(a.sql, /asin\(sqrt/);
  assert.deepEqual(a.values.slice(-2), [150, 150]);
  const b = buildIndexQuery({ query: '', contractType: 'tous' }, { label: '13', departement: '13' }, 'France Travail', ['J1501']);
  assert.match(b.sql, /rome_code = any/);
  assert.match(b.sql, /departement = \$3/);
  assert.doesNotMatch(b.sql, /plainto_tsquery/);
});

const CONN = (process.env.AUTOMATION_PG || '').split(/\s+/).filter(Boolean);
test('PostgreSQL : recherche réelle dans la base (plein texte, rayon, département, contrat, codes métier, base vide)', { skip: CONN.length ? false : 'AUTOMATION_PG non défini' }, async () => {
  const DB = `kareer_search_${process.pid}`;
  const psql = (args: string[]) => execFileSync('psql', [...CONN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  psql(['-d', 'postgres', '-qc', `drop database if exists ${DB}`, '-c', `create database ${DB}`]);
  for (const f of ['tests/sql/supabase-shim.sql', 'supabase/migrations/001_init.sql', 'supabase/migrations/002_automation.sql', 'supabase/migrations/007_offer_index.sql']) psql(['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f]);
  const arg = (f: string) => { const i = CONN.indexOf(f); return i >= 0 ? CONN[i + 1] : undefined; };
  const host = arg('-h') || 'localhost', port = arg('-p') || '5432', user = arg('-U') || 'postgres';
  const url = host.startsWith('/') ? `postgresql://${user}@/${DB}?host=${encodeURIComponent(host)}&port=${port}` : `postgresql://${user}@${host}:${port}/${DB}?sslmode=disable`;
  const pool = new pg.Pool({ connectionString: url });
  const store = new PgOfferStore(pool);
  const search = new PgOfferSearch(pool);
  const romes = async () => ['J1501'];
  try {
    // Base vide : null (la recherche repassera sur l'API)
    assert.equal(await search.search({ query: 'aide' }, null, romes), null);
    (search as any).readyUntil = 0;

    const mk = (id: string, o: any) => toOfferRow(normalizeFtJob({ id, entreprise: { nom: `Employeur ${id}` }, dateCreation: '2026-09-20T10:00:00Z', typeContrat: 'CDI', ...o })!);
    await store.upsertOffers([
      mk('A', { intitule: 'Aide-soignant de nuit', romeCode: 'J1501', lieuTravail: { libelle: '84 - Avignon', latitude: 43.949, longitude: 4.805 } }),
      mk('B', { intitule: 'Aide-soignante en EHPAD', romeCode: 'J1501', lieuTravail: { libelle: '84 - Carpentras', latitude: 44.055, longitude: 5.048 }, typeContrat: 'CDD' }),
      mk('C', { intitule: 'Aide soignant', romeCode: 'J1501', lieuTravail: { libelle: '13 - Marseille', latitude: 43.296, longitude: 5.369 } }),
      mk('D', { intitule: 'Agent de service hospitalier', romeCode: 'J1301', lieuTravail: { libelle: '84 - Avignon' } }),
      mk('E', { intitule: 'Auxiliaire de soins', romeCode: 'J1501', lieuTravail: { libelle: '84 - Orange' } })
    ], new Date().toISOString());

    const ids = async (params: any, geo: any) => (await search.search(params, geo, romes))!.jobs.map((j) => j.id).sort();
    const avignon = { label: 'Avignon', latitude: 43.949, longitude: 4.805, departement: '84' };
    // Plein texte en français : « aide soignante » trouve aussi « aide-soignant »
    assert.deepEqual(await ids({ query: 'aide soignante' }, null), ['ft-A', 'ft-B', 'ft-C']);
    // Rayon de 10 km autour d'Avignon : Carpentras (~24 km) exclu ; offre sans coordonnées du 84 (E) gardée si elle correspond
    assert.deepEqual(await ids({ query: 'aide soignant', radius: 10 }, avignon), ['ft-A']);
    assert.deepEqual(await ids({ query: 'aide soignant', radius: 40 }, avignon), ['ft-A', 'ft-B']);
    // Département seul
    assert.deepEqual(await ids({ query: 'aide soignant' }, { label: '13', departement: '13' }), ['ft-C']);
    // Contrat
    assert.deepEqual(await ids({ query: 'aide soignant', contractType: 'cdd' }, null), ['ft-B']);
    // Aucun mot trouvé : repli sur les codes métier (ROME)
    assert.deepEqual(await ids({ query: 'infirmier auxiliaire gériatrie' }, avignon), ['ft-A', 'ft-B', 'ft-E']);
    // Sans mot-clé : toutes les offres de la zone
    assert.deepEqual(await ids({ query: '' }, { label: '84', departement: '84' }), ['ft-A', 'ft-B', 'ft-D', 'ft-E']);
  } finally {
    await pool.end();
    psql(['-d', 'postgres', '-qc', `drop database if exists ${DB} with (force)`]);
  }
});
