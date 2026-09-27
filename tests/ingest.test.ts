import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { collectDepartement, syncFranceTravail, DEPARTEMENTS, FT_MAX_RESULTS, ftDate, type FtSearch } from '../server/ingest/franceTravail.ts';
import { MemoryOfferStore, PgOfferStore, fingerprintOf, toOfferRow } from '../server/ingest/offerStore.ts';
import { applyHostFamily, classifyApply } from '../server/ingest/applyHosts.ts';
import { ftDepartement, normalizeFtJob } from '../server/jobSources.ts';

// ---------------------------------------------------------------------------
// Faux service France Travail : mêmes règles que l'API (150 par page, 3 150 résultats au plus, Content-Range)
// ---------------------------------------------------------------------------
type FakeOffer = { id: string; dep: string; created: string; [k: string]: unknown };

function fakeFt(offers: FakeOffer[], opts: { failFirst?: number } = {}) {
  const calls: string[] = [];
  let failures = opts.failFirst || 0;
  const search: FtSearch = async (qs) => {
    calls.push(qs.toString());
    if (failures > 0) { failures--; return { status: 429, offers: [], total: null }; }
    const [start, end] = (qs.get('range') || '0-149').split('-').map(Number);
    if (start > 3000 || end - start >= 150) return { status: 400, offers: [], total: null };
    const min = qs.get('minCreationDate'), max = qs.get('maxCreationDate');
    const match = offers
      .filter((o) => o.dep === qs.get('departement') && (!min || o.created >= min) && (!max || o.created <= max))
      .sort((a, b) => b.created.localeCompare(a.created));
    if (!match.length) return { status: 204, offers: [], total: 0 };
    const page = match.slice(start, end + 1).map((o) => ({
      id: o.id, intitule: `Aide-soignant ${o.id}`, dateCreation: o.created, romeCode: 'J1501',
      entreprise: { nom: `EHPAD ${o.id}` }, lieuTravail: { libelle: `${o.dep} - Ville`, commune: `${o.dep}001` },
      typeContrat: 'CDI', description: 'Soins', ...Object.fromEntries(Object.entries(o).filter(([k]) => !['id', 'dep', 'created'].includes(k)))
    }));
    return { status: page.length < match.length ? 206 : 200, offers: page, total: match.length };
  };
  return { search, calls };
}

const at = (minutesAgo: number, now = new Date('2026-09-27T12:00:00Z')) => ftDate(new Date(now.getTime() - minutesAgo * 60_000));
const noWait = { sleep: async () => {}, rps: 1000 };

test('départements : métropole, Corse et outre-mer', () => {
  assert.equal(DEPARTEMENTS.length, 101);
  assert.ok(DEPARTEMENTS.includes('2A') && DEPARTEMENTS.includes('976') && !DEPARTEMENTS.includes('20'));
});

test('collecte : au-delà de 3 150 résultats, la période est découpée et TOUTES les offres sont récupérées', async () => {
  // 5 000 offres dans les Bouches-du-Rhône, réparties sur 100 jours
  const offers = Array.from({ length: 5000 }, (_, i) => ({ id: `B${i}`, dep: '13', created: at(i * 29) }));
  const ft = fakeFt(offers);
  const seen = new Set<string>();
  const res = await collectDepartement('13', new Date('2026-06-01T00:00:00Z'), new Date('2026-09-27T12:00:00Z'), async (page) => { for (const o of page) seen.add(o.id); }, { search: ft.search, ...noWait });
  assert.equal(seen.size, 5000);
  assert.ok(res.splits >= 1);
  assert.equal(res.truncated, false);
  // Aucune requête hors des limites de l'API
  for (const c of ft.calls) {
    const [s, e] = new URLSearchParams(c).get('range')!.split('-').map(Number);
    assert.ok(s <= 3000 && e - s < 150, c);
  }
});

test('collecte : surcharge (429) → nouvelle tentative, pas d\'échec', async () => {
  const ft = fakeFt([{ id: 'A1', dep: '84', created: at(10) }], { failFirst: 2 });
  let n = 0;
  const res = await collectDepartement('84', new Date('2026-09-01T00:00:00Z'), new Date('2026-09-27T12:00:00Z'), async (p) => { n += p.length; }, { search: ft.search, ...noWait });
  assert.equal(n, 1);
  assert.equal(res.pages, 3);
});

test('synchronisation : complète puis incrémentale ; offres retirées désactivées au balayage complet', async () => {
  const store = new MemoryOfferStore();
  const offers: FakeOffer[] = [
    { id: 'X1', dep: '84', created: at(60 * 24 * 5) },
    { id: 'X2', dep: '84', created: at(60 * 24 * 2), contact: { courriel: 'recrutement@ehpad-x2.fr' } },
    { id: 'X3', dep: '13', created: at(60 * 24), origineOffre: { origine: '2', urlOrigine: 'https://www.hellowork.com/fr-fr/emplois/1.html', partenaires: [{ nom: 'HELLOWORK' }] } }
  ];
  const ft = fakeFt(offers);
  const now1 = new Date('2026-09-27T12:00:00Z');
  const s1 = await syncFranceTravail(store, { search: ft.search, ...noWait, mode: 'full', departements: ['84', '13'], now: () => now1 });
  assert.equal(s1.fetched, 3);
  assert.equal(s1.inserted, 3);
  assert.deepEqual(s1.errors, []);
  const x2 = store.rows.get('ft-X2')!;
  assert.deepEqual([x2.applyKind, x2.applyHost, x2.departement, x2.romeCode], ['email', 'email', '84', 'J1501']);
  const x3 = store.rows.get('ft-X3')!;
  assert.deepEqual([x3.applyKind, x3.applyHost, x3.partner], ['platform', 'hellowork', 'HELLOWORK']);

  // Une heure plus tard : une nouvelle offre ; la collecte incrémentale ne redemande que la période récente
  offers.push({ id: 'X4', dep: '84', created: ftDate(new Date('2026-09-27T12:30:00Z')) });
  ft.calls.length = 0;
  const now2 = new Date('2026-09-27T13:00:00Z');
  const s2 = await syncFranceTravail(store, { search: ft.search, ...noWait, mode: 'incremental', departements: ['84'], now: () => now2 });
  assert.equal(s2.inserted, 1);
  const min = new URLSearchParams(ft.calls[0]).get('minCreationDate')!;
  assert.equal(min, '2026-09-27T11:00:00Z', 'depuis la dernière collecte, moins une heure de recouvrement');
  assert.equal(s2.deactivated, 0, 'pas de désactivation en incrémental');

  // Le lendemain, X1 a été retirée : le balayage complet la désactive
  offers.splice(offers.findIndex((o) => o.id === 'X1'), 1);
  const now3 = new Date('2026-09-28T12:00:00Z');
  const s3 = await syncFranceTravail(store, { search: ft.search, ...noWait, mode: 'full', departements: ['84'], now: () => now3 });
  assert.equal(s3.deactivated, 1);
  assert.equal(store.rows.get('ft-X1')!.active, false);
  assert.equal(store.rows.get('ft-X2')!.active, true);
  assert.equal((await store.countActive()).total, 3);
  const state = await store.getState('France Travail', 'dep:84');
  assert.equal(state?.lastFullAt, now3.toISOString());
});

test('synchronisation : un département en erreur n\'arrête pas les autres', async () => {
  const store = new MemoryOfferStore();
  const ok = fakeFt([{ id: 'Y1', dep: '75', created: at(30) }]);
  const search: FtSearch = async (qs) => (qs.get('departement') === '13' ? { status: 403, offers: [], total: null } : ok.search(qs));
  const s = await syncFranceTravail(store, { search, ...noWait, mode: 'full', departements: ['13', '75'], now: () => new Date('2026-09-27T12:00:00Z') });
  assert.equal(s.errors.length, 1);
  assert.equal(s.fetched, 1);
  assert.match((await store.getState('France Travail', 'dep:13'))!.lastError!, /403/);
});

test('offre France Travail : département, code métier, partenaire, empreinte stable entre sources', () => {
  const o = normalizeFtJob({ id: '1', intitule: 'Chauffeur livreur H/F', entreprise: { nom: 'Transports Sud SAS' }, lieuTravail: { libelle: '2A - Ajaccio' }, romeCode: 'N4105', origineOffre: { partenaires: [{ nom: 'INDEED' }] } })!;
  assert.deepEqual([o.departement, o.romeCode, o.sourcePartner], ['2A', 'N4105', 'INDEED']);
  assert.equal(ftDepartement({ lieuTravail: { commune: '97411' } }), '974');
  assert.equal(
    fingerprintOf({ company: 'Transports Sud SAS', title: 'Chauffeur livreur (H/F)', location: '', departement: '2A' }),
    fingerprintOf({ company: 'TRANSPORTS SUD', title: 'Chauffeur-livreur', location: '', departement: '2A' })
  );
});

test('pages de candidature : familles reconnues (logiciels, plateformes, intérim, services publics)', () => {
  assert.equal(applyHostFamily('https://acme.wd3.myworkdayjobs.com/fr-FR/careers/job/1'), 'workday');
  assert.equal(applyHostFamily('https://www.taleez.com/apply/1'), 'taleez');
  assert.equal(applyHostFamily('https://fr.indeed.com/viewjob?jk=1'), 'indeed');
  assert.equal(applyHostFamily('https://www.adecco.fr/offres/1'), 'adecco');
  assert.equal(applyHostFamily('https://candidat.francetravail.fr/offres/1'), 'francetravail');
  assert.equal(applyHostFamily('https://carrieres.exemple-pme.fr/poste'), 'autre:exemple-pme.fr');
  assert.deepEqual(classifyApply({ applyUrl: 'https://jobs.lever.co/acme/6ed76ce8-4156-4b60-b120-403538bd66cd' }), { kind: 'lever', host: 'lever' });
  assert.deepEqual(classifyApply({ applyUrl: 'https://candidat.francetravail.fr/offres/1', contactEmail: 'rh@pme.fr' }), { kind: 'email', host: 'email' });
  assert.deepEqual(classifyApply({ applyUrl: 'https://labonnealternance.apprentissage.beta.gouv.fr/x', lbaRecipientId: 'r' }), { kind: 'lba', host: 'labonnealternance' });
});

// ---------------------------------------------------------------------------
// PostgreSQL (migration 007)
// ---------------------------------------------------------------------------
const CONN = (process.env.AUTOMATION_PG || '').split(/\s+/).filter(Boolean);
test('PostgreSQL : écriture par lots, mise à jour, désactivation, recherche plein texte, mesures, verrou', { skip: CONN.length ? false : 'AUTOMATION_PG non défini' }, async () => {
  const DB = `kareer_ingest_${process.pid}`;
  const psql = (args: string[]) => execFileSync('psql', [...CONN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  psql(['-d', 'postgres', '-qc', `drop database if exists ${DB}`, '-c', `create database ${DB}`]);
  for (const f of ['tests/sql/supabase-shim.sql', 'supabase/migrations/001_init.sql', 'supabase/migrations/002_automation.sql', 'supabase/migrations/003_push.sql', 'supabase/migrations/006_lba_channel.sql', 'supabase/migrations/007_offer_index.sql']) {
    psql(['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f]);
  }
  const arg = (f: string) => { const i = CONN.indexOf(f); return i >= 0 ? CONN[i + 1] : undefined; };
  const host = arg('-h') || 'localhost', port = arg('-p') || '5432', user = arg('-U') || 'postgres';
  const url = host.startsWith('/') ? `postgresql://${user}@/${DB}?host=${encodeURIComponent(host)}&port=${port}` : `postgresql://${user}@${host}:${port}/${DB}?sslmode=disable`;
  const store = new PgOfferStore(new pg.Pool({ connectionString: url }));
  try {
    const job = (id: string, over: any = {}) => normalizeFtJob({ id, intitule: 'Aide-soignant de nuit H/F', entreprise: { nom: 'EHPAD Les Tilleuls' }, lieuTravail: { libelle: '84 - Avignon' }, romeCode: 'J1501', typeContrat: 'CDI', dateCreation: '2026-09-20T10:00:00Z', ...over })!;
    const t1 = '2026-09-27T12:00:00.000Z';
    assert.deepEqual(await store.upsertOffers([toOfferRow(job('1')), toOfferRow(job('2', { contact: { courriel: 'rh@ehpad.fr' } }))], t1), { inserted: 2, updated: 0 });
    assert.deepEqual(await store.upsertOffers([toOfferRow(job('1', { intitule: 'Aide-soignante de nuit' }))], '2026-09-28T12:00:00.000Z'), { inserted: 0, updated: 1 });
    const { rows } = await store.pool.query(`select id, title, departement, rome_code, apply_kind from public.job_offers where search @@ plainto_tsquery('french', 'aide soignante') order by id`);
    assert.deepEqual(rows.map((r) => [r.id, r.departement, r.rome_code, r.apply_kind]), [['ft-1', '84', 'J1501', 'platform'], ['ft-2', '84', 'J1501', 'email']]);
    assert.equal(await store.deactivateUnseen('France Travail', '84', '2026-09-28T00:00:00.000Z'), 1, 'ft-2 non revue');
    assert.deepEqual(await store.countActive(), { total: 1, bySource: { 'France Travail': 1 } });
    assert.deepEqual((await store.channelStats()).map((s) => [s.kind, s.host, s.count]), [['platform', 'francetravail', 1]]);
    await store.saveState({ source: 'France Travail', partition: 'dep:84', lastSuccessAt: t1, lastFullAt: t1, lastError: null, stats: { fetched: 2 } });
    assert.equal((await store.getState('France Travail', 'dep:84'))?.lastSuccessAt, t1);
    // Verrou : un seul collecteur à la fois
    let inner: unknown = 'pas lancé';
    const outer = await store.withLock('ingest:test', async () => { inner = await store.withLock('ingest:test', async () => 'doublon'); return 'ok'; });
    assert.equal(outer, 'ok');
    assert.equal(inner, null);
  } finally {
    await store.close();
    psql(['-d', 'postgres', '-qc', `drop database if exists ${DB} with (force)`]);
  }
});
