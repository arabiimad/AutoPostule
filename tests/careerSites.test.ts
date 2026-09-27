import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { extractJobPostings, normalizeJobPosting, departementOf, siteNameOf } from '../server/ingest/jobPosting.ts';
import { parseRobots, crawlSite, isJobUrl, syncCareerSites, siteSeeds, companySite, type FetchedPage } from '../server/ingest/careerSites.ts';
import { MemoryOfferStore, PgOfferStore, toOfferRow } from '../server/ingest/offerStore.ts';
import { searchRealJobs, setSiteIndex, __setFetchForTests, __clearCacheForTests } from '../server/jobSources.ts';

after(() => setSiteIndex(null));

const NOW = new Date('2026-09-27T10:00:00Z');
const posting = (o: any = {}) => ({
  '@context': 'https://schema.org', '@type': 'JobPosting',
  title: 'Aide-soignant(e) de nuit', description: '<p>Rejoignez notre EHPAD. <b>CDI</b> temps plein.</p>',
  datePosted: '2026-09-10', validThrough: '2026-12-31',
  hiringOrganization: { '@type': 'Organization', name: 'Résidence Les Tilleuls', sameAs: 'https://tilleuls.fr' },
  jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Avignon', postalCode: '84000', addressCountry: 'FR' }, geo: { latitude: 43.95, longitude: 4.81 } },
  employmentType: 'FULL_TIME',
  ...o
});
const page = (...jps: any[]) => `<html><head>${jps.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join('')}</head><body></body></html>`;

test('JSON-LD : offres dans un tableau, un @graph ou une liste ; blocs mal échappés tolérés', () => {
  const html = page([posting({ title: 'A' }), { '@type': 'Organization', name: 'x' }])
    + `<script type='application/ld+json'>{"@graph":[{"@type":["JobPosting"],"title":"B"}]}</script>`
    + `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"ListItem","item":{"@type":"JobPosting","title":"C"}}]}</script>`
    + `<script type="application/ld+json">{"@type":"JobPosting","title":"D","description":"ligne 1\nligne 2"}</script>`
    + `<script type="application/ld+json">{ cassé </script>`;
  assert.deepEqual(extractJobPostings(html).map((j) => j.title), ['A', 'B', 'C', 'D']);
});

test('JobPosting → offre : lieu, département, contrat, salaire, email ; offres expirées ou hors de France écartées', () => {
  const ctx = { pageUrl: 'https://tilleuls.fr/recrutement/aide-soignant', site: 'tilleuls.fr', now: NOW };
  const o = normalizeJobPosting(posting({
    baseSalary: { '@type': 'MonetaryAmount', currency: 'EUR', value: { '@type': 'QuantitativeValue', minValue: 1900, maxValue: 2200, unitText: 'MONTH' } },
    applicationContact: { email: 'mailto:RH@tilleuls.fr' }
  }), ctx)!;
  assert.equal(o.title, 'Aide-soignant(e) de nuit');
  assert.equal(o.company, 'Résidence Les Tilleuls');
  assert.equal(o.location, 'Avignon (84)');
  assert.equal(o.departement, '84');
  assert.equal(o.latitude, 43.95);
  assert.equal(o.contractType, 'cdi');
  assert.match(o.salary!, /1\s?900 € – 2\s?200 € par mois/);
  assert.equal(o.contactEmail, 'rh@tilleuls.fr');
  assert.equal(o.source, 'Sites carrière');
  assert.equal(o.applyUrl, ctx.pageUrl);
  assert.match(o.id, /^site-tilleuls\.fr:[0-9a-f]{16}$/);
  assert.equal(toOfferRow(o).sourceRef.startsWith('tilleuls.fr:'), true);
  // « FULL_TIME » par défaut, mais le texte dit alternance
  assert.equal(normalizeJobPosting(posting({ title: 'Apprenti boulanger', description: 'Contrat en apprentissage' }), ctx)!.contractType, 'alternance');
  assert.equal(normalizeJobPosting(posting({ employmentType: ['TEMPORARY'], description: 'x' }), ctx)!.contractType, 'cdd');
  // Expirée, hors de France, sans titre
  assert.equal(normalizeJobPosting(posting({ validThrough: '2026-09-01' }), ctx), null);
  assert.equal(normalizeJobPosting(posting({ jobLocation: { address: { addressLocality: 'Genève', addressCountry: 'CH' } } }), ctx), null);
  assert.equal(normalizeJobPosting(posting({ title: '' }), ctx), null);
  // Plusieurs lieux : le premier en France est retenu ; pays écrit en toutes lettres
  const multi = normalizeJobPosting(posting({ jobLocation: [{ address: { addressLocality: 'Bruxelles', addressCountry: 'BE' } }, { address: { addressLocality: 'Ajaccio', postalCode: '20000', addressCountry: { name: 'France' } } }] }), ctx)!;
  assert.equal(multi.departement, '2A');
  // Télétravail sans lieu
  assert.equal(normalizeJobPosting(posting({ jobLocation: undefined, jobLocationType: 'TELECOMMUTE' }), ctx)!.remote, 'total');
  // Code postal dans le nom de la ville ; enseigne tirée du nom du site quand l'offre ne donne que le magasin
  const store = normalizeJobPosting(posting({ hiringOrganization: { name: 'Orléans - Ingré' }, jobLocation: { address: { addressLocality: 'Ingré (45140)', addressCountry: 'FR' } } }), { ...ctx, siteName: 'Leroy Merlin' })!;
  assert.equal(store.location, 'Ingré (45)');
  assert.equal(store.departement, '45');
  assert.equal(store.company, 'Leroy Merlin – Orléans - Ingré');
  assert.equal(normalizeJobPosting(posting({ hiringOrganization: { name: 'Leroy Merlin France' } }), { ...ctx, siteName: 'Leroy Merlin' })!.company, 'Leroy Merlin France');
  assert.equal(siteNameOf('<meta property="og:site_name" content="Leroy Merlin">'), 'Leroy Merlin');
  assert.equal(departementOf('97411'), '974');
  assert.equal(departementOf('20600'), '2B');
});

test('robots.txt : groupe KareerBot sinon « * », règle la plus longue, jokers, délai, plans du site', () => {
  const r = parseRobots(`# commentaire
User-agent: Googlebot
Disallow: /

User-agent: *
Disallow: /admin
Disallow: /*.pdf$
Allow: /admin/public
Crawl-delay: 30
Sitemap: https://ex.fr/sitemap.xml`);
  assert.equal(r.allowed('/recrutement/offre-1'), true);
  assert.equal(r.allowed('/admin/x'), false);
  assert.equal(r.allowed('/admin/public/offres'), true);
  assert.equal(r.allowed('/doc/fiche.pdf'), false);
  assert.equal(r.allowed('/doc/fiche.pdf?x=1'), true);
  assert.equal(r.crawlDelayMs, 10_000, 'plafonné à 10 s');
  assert.deepEqual(r.sitemaps, ['https://ex.fr/sitemap.xml']);
  const own = parseRobots(`User-agent: *\nDisallow:\n\nUser-agent: KareerBot\nDisallow: /`);
  assert.equal(own.allowed('/emplois'), false);
  assert.equal(parseRobots(`User-agent: *\nDisallow:`).allowed('/x'), true);
});

/** Faux site : chemin → [statut, corps, type]. */
function fakeSite(pages: Record<string, [number, string, string?]>) {
  const calls: string[] = [];
  const fetcher = async (url: string): Promise<FetchedPage> => {
    calls.push(url);
    const u = new URL(url);
    if (u.hostname !== 'www.tilleuls.fr') throw new Error('injoignable');
    const p = pages[u.pathname + u.search];
    return p ? { status: p[0], url, body: p[1], contentType: p[2] || 'text/html' } : { status: 404, url, body: 'introuvable', contentType: 'text/html' };
  };
  return { fetcher, calls };
}
const noSleep = async () => {};

test('site : plan du site → pages d\'offres, robots.txt respecté, offres expirées ignorées', async () => {
  const { fetcher, calls } = fakeSite({
    '/robots.txt': [200, 'User-agent: *\nDisallow: /recrutement/interne\nSitemap: https://www.tilleuls.fr/sitemap_index.xml', 'text/plain'],
    '/sitemap_index.xml': [200, '<sitemapindex><sitemap><loc>https://www.tilleuls.fr/post-sitemap.xml</loc></sitemap><sitemap><loc>https://www.tilleuls.fr/job-sitemap.xml</loc></sitemap></sitemapindex>', 'application/xml'],
    '/job-sitemap.xml': [200, '<urlset><url><loc>https://www.tilleuls.fr/recrutement/as-nuit</loc></url><url><loc><![CDATA[https://www.tilleuls.fr/recrutement/ide]]></loc></url><url><loc>https://www.tilleuls.fr/recrutement/interne/cadre</loc></url><url><loc>https://www.tilleuls.fr/recrutement/ancienne</loc></url></urlset>', 'application/xml'],
    '/recrutement/as-nuit': [200, page(posting())],
    '/recrutement/ide': [200, page(posting({ title: 'Infirmier (H/F)', identifier: { value: 'IDE-1' } }))],
    '/recrutement/interne/cadre': [200, page(posting({ title: 'Secret' }))],
    '/recrutement/ancienne': [200, page(posting({ title: 'Vieille', validThrough: '2026-01-01' }))]
  });
  const r = await crawlSite('tilleuls.fr', { fetcher, sleep: noSleep, now: () => NOW });
  assert.equal(r.blocked, undefined);
  assert.deepEqual(r.offers.map((o) => o.title).sort(), ['Aide-soignant(e) de nuit', 'Infirmier (H/F)']);
  assert.ok(!calls.some((c) => c.includes('/interne/')), 'page interdite par robots.txt jamais demandée');
  assert.ok(!calls.some((c) => c.includes('post-sitemap')), 'plans du site sans rapport ignorés');
});

test('site sans plan : page carrière depuis l\'accueil, liens d\'offres, pages carrière hébergées repérées', async () => {
  const { fetcher } = fakeSite({
    '/robots.txt': [404, ''],
    '/': [200, '<a href="/qui-sommes-nous">Nous</a> <a href="/nous-rejoindre">Nous rejoindre</a>'],
    '/nous-rejoindre': [200, '<a href="/offre/12-aide-soignant">Aide-soignant</a> <a href="https://jobs.lever.co/tilleuls">Toutes nos offres</a> <a href="/offre/plan.pdf">PDF</a>'],
    '/offre/12-aide-soignant': [200, page(posting())]
  });
  const r = await crawlSite('tilleuls.fr', { fetcher, sleep: noSleep, now: () => NOW });
  assert.equal(r.offers.length, 1);
  assert.deepEqual(r.boards, ['https://jobs.lever.co/tilleuls']);
});

test('sous-domaine de recrutement : son propre robots.txt, point d\'entrée direct', async () => {
  const calls: string[] = [];
  const hosts: Record<string, Record<string, [number, string]>> = {
    'recrutement.tilleuls.fr': {
      '/robots.txt': [200, 'User-agent: *\nDisallow: /offre/brouillon'],
      '/': [200, '<a href="/offre/1">AS</a> <a href="/offre/brouillon">x</a> <a href="https://www.tilleuls.fr/offre/9">site principal</a>'],
      '/offre/1': [200, page(posting())]
    },
    'www.tilleuls.fr': { '/robots.txt': [200, 'User-agent: *\nDisallow: /'] }
  };
  const fetcher = async (url: string): Promise<FetchedPage> => {
    calls.push(url);
    const u = new URL(url);
    const p = hosts[u.hostname]?.[u.pathname];
    return p ? { status: p[0], url, body: p[1], contentType: u.pathname.endsWith('.txt') ? 'text/plain' : 'text/html' } : { status: 404, url, body: '', contentType: 'text/html' };
  };
  const r = await crawlSite('recrutement.tilleuls.fr', { fetcher, sleep: noSleep, now: () => NOW });
  assert.equal(r.offers.length, 1);
  assert.ok(!calls.some((c) => c.includes('brouillon')));
  // Autre sous-domaine de l'entreprise : ses propres règles (tout interdit) sont respectées
  assert.ok(calls.includes('https://www.tilleuls.fr/robots.txt'));
  assert.ok(!calls.includes('https://www.tilleuls.fr/offre/9'));
});

test('redirection vers un autre sous-domaine, protection anti-robots', async () => {
  const fetcher = async (url: string): Promise<FetchedPage> => {
    const u = new URL(url);
    if (u.hostname === 'recrutement.tilleuls.fr') return u.pathname === '/robots.txt'
      ? { status: 404, url, body: '', contentType: 'text/html' }
      : { status: 200, url: 'https://recrute.tilleuls.fr/', body: '<a href="/offres/as">AS</a>', contentType: 'text/html' };
    if (u.hostname === 'recrute.tilleuls.fr') return u.pathname === '/offres/as'
      ? { status: 200, url, body: page(posting()), contentType: 'text/html' }
      : { status: 404, url, body: '', contentType: 'text/html' };
    return { status: 403, url, body: 'Access denied', contentType: 'text/html' };
  };
  const r = await crawlSite('recrutement.tilleuls.fr', { fetcher, sleep: noSleep, now: () => NOW });
  assert.equal(r.offers.length, 1);
  assert.equal(r.offers[0].applyUrl, 'https://recrute.tilleuls.fr/offres/as');
  const blocked = await crawlSite('grande-enseigne.fr', { fetcher: async (url) => ({ status: url.endsWith('robots.txt') ? 200 : 403, url, body: 'User-agent: *\nAllow: /', contentType: 'text/plain' }), sleep: noSleep });
  assert.equal(blocked.blocked, 'accès refusé (protection anti-robots)');
  assert.equal(blocked.pages, 2, 'robots.txt et accueil seulement');
});

test('adresses d\'offres : mots entiers, pas les noms de villes', () => {
  for (const p of ['/offres/aide-soignant-12', '/offre-emploi-cuisinier', '/jobs/123', '/fr/carrieres/', '/recrutement', '/emploi_boulanger.html', '/nous-rejoindre']) assert.ok(isJobUrl(p), p);
  for (const p of ['/c/offres-du-jour/s10078493', '/s/fr-FR/supermarches/carrieres-sous-poissy/route-1/', '/produits/jobsite', '/blog/nos-postes-de-travail-ergonomiques']) assert.ok(!isJobUrl(p), p);
});

test('site fermé aux robots, en panne ou injoignable : rien n\'est lu', async () => {
  const closed = fakeSite({ '/robots.txt': [200, 'User-agent: *\nDisallow: /', 'text/plain'] });
  const r1 = await crawlSite('tilleuls.fr', { fetcher: closed.fetcher, sleep: noSleep });
  assert.equal(r1.blocked, 'interdit par robots.txt');
  assert.equal(closed.calls.length, 1);
  const down = fakeSite({ '/robots.txt': [503, ''] });
  assert.match((await crawlSite('tilleuls.fr', { fetcher: down.fetcher, sleep: noSleep })).blocked!, /503/);
  assert.equal((await crawlSite('inconnu.fr', { fetcher: down.fetcher, sleep: noSleep })).blocked, 'site injoignable');
});

test('politesse : délai demandé par le site entre deux requêtes', async () => {
  const { fetcher } = fakeSite({
    '/robots.txt': [200, 'User-agent: *\nCrawl-delay: 4\nSitemap: https://www.tilleuls.fr/jobs.xml', 'text/plain'],
    '/jobs.xml': [200, '<urlset><url><loc>https://www.tilleuls.fr/jobs/1</loc></url></urlset>'],
    '/jobs/1': [200, page(posting())]
  });
  const waits: number[] = [];
  await crawlSite('tilleuls.fr', { fetcher, sleep: async (ms) => { waits.push(ms); }, delayMs: 1000, now: () => NOW });
  assert.equal(waits.length, 3, 'robots.txt, accueil, plan du site, offre');
  assert.ok(waits.every((w) => w > 3000 && w <= 4000));
});

test('collecte : enregistrement, pas de nouvelle visite avant 24 h, offres retirées désactivées', async () => {
  const store = new MemoryOfferStore();
  let pages: Record<string, [number, string, string?]> = {
    '/robots.txt': [200, 'Sitemap: https://www.tilleuls.fr/jobs.xml', 'text/plain'],
    '/jobs.xml': [200, '<urlset><url><loc>https://www.tilleuls.fr/jobs/1</loc></url><url><loc>https://www.tilleuls.fr/jobs/2</loc></url></urlset>'],
    '/jobs/1': [200, page(posting())],
    '/jobs/2': [200, page(posting({ title: 'Cuisinier', identifier: 'C2' }))]
  };
  const fetcher = async (url: string) => fakeSite(pages).fetcher(url);
  const s1 = await syncCareerSites(store, ['tilleuls.fr'], { fetcher, sleep: noSleep, now: () => NOW });
  assert.equal(s1.inserted, 2);
  const s2 = await syncCareerSites(store, ['tilleuls.fr'], { fetcher, sleep: noSleep, now: () => new Date(NOW.getTime() + 3600_000) });
  assert.equal(s2.sites, 0, 'visité il y a une heure');
  pages = { ...pages, '/jobs.xml': [200, '<urlset><url><loc>https://www.tilleuls.fr/jobs/1</loc></url></urlset>'] };
  const s3 = await syncCareerSites(store, ['tilleuls.fr', 'autre.fr'], { fetcher, sleep: noSleep, now: () => new Date(NOW.getTime() + 25 * 3600_000), maxSites: 1 });
  assert.equal(s3.sites, 1, 'plafond de sites par collecte');
  assert.equal(s3.deactivated, 1);
  assert.deepEqual((await store.countActive()).bySource, { 'Sites carrière': 1 });
});

test('sites à visiter : employeurs seulement (ni sites d\'emploi, ni réseaux sociaux, ni services publics)', () => {
  assert.equal(companySite('https://www.boulangerie-martin.fr/contact'), 'boulangerie-martin.fr');
  assert.equal(companySite('https://www.groupe-exemple.com/fr'), 'groupe-exemple.com');
  assert.equal(companySite('https://recrutement.groupe-exemple.com/offre/1'), 'recrutement.groupe-exemple.com', 'sous-domaine de recrutement gardé');
  assert.equal(companySite('https://boutique.groupe-exemple.com'), 'groupe-exemple.com');
  assert.equal(companySite('https://shop.acme.co.uk'), 'acme.co.uk');
  for (const u of ['https://fr.indeed.com/x', 'https://www.linkedin.com/company/x', 'https://www.welcometothejungle.com/fr', 'https://www.facebook.com/x', 'https://www.service-public.gouv.fr', 'https://candidat.francetravail.fr/x', 'pas une adresse']) {
    assert.equal(companySite(u), null, u);
  }
  assert.deepEqual(siteSeeds([{ url: 'https://a.fr', offers: 3 }, { url: 'https://www.b.fr/emploi', offers: 9 }, { url: 'https://b.fr', offers: 1 }, { url: 'https://indeed.fr', offers: 50 }], 'manuel.fr'), ['manuel.fr', 'b.fr', 'a.fr']);
});

test('recherche : offres des sites d\'employeurs ajoutées aux résultats (source « Sites carrière »)', async () => {
  __clearCacheForTests();
  for (const k of ['FT_CLIENT_ID', 'FT_CLIENT_SECRET', 'LBA_API_KEY', 'JSEARCH_API_KEY', 'ADZUNA_APP_ID', 'JOOBLE_API_KEY']) delete process.env[k];
  __setFetchForTests(async () => ({ ok: true, status: 200, json: async () => [], text: async () => '[]' }));
  const job = normalizeJobPosting(posting(), { pageUrl: 'https://tilleuls.fr/r/1', site: 'tilleuls.fr', now: NOW })!;
  setSiteIndex(async () => ({ jobs: [job], full: false }));
  const r = await searchRealJobs({ query: 'aide-soignant', location: '', contractType: 'tous' });
  assert.deepEqual(r.jobs.map((j) => j.source), ['Sites carrière']);
  assert.equal(r.sources.sitesCarriere.count, 1);
  setSiteIndex(null);
});

const CONN = (process.env.AUTOMATION_PG || '').split(/\s+/).filter(Boolean);
test('PostgreSQL : offres retirées d\'un site, sites d\'employeurs tirés des offres collectées', { skip: CONN.length ? false : 'AUTOMATION_PG non défini' }, async () => {
  const DB = `kareer_sites_${process.pid}`;
  const psql = (a: string[]) => execFileSync('psql', [...CONN, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
  psql(['-d', 'postgres', '-qc', `drop database if exists ${DB}`, '-c', `create database ${DB}`]);
  for (const f of ['tests/sql/supabase-shim.sql', 'supabase/migrations/001_init.sql', 'supabase/migrations/002_automation.sql', 'supabase/migrations/007_offer_index.sql']) psql(['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f]);
  const arg = (f: string) => { const i = CONN.indexOf(f); return i >= 0 ? CONN[i + 1] : undefined; };
  const host = arg('-h') || 'localhost', port = arg('-p') || '5432', user = arg('-U') || 'postgres';
  const url = host.startsWith('/') ? `postgresql://${user}@/${DB}?host=${encodeURIComponent(host)}&port=${port}` : `postgresql://${user}@${host}:${port}/${DB}?sslmode=disable`;
  const pool = new pg.Pool({ connectionString: url });
  const store = new PgOfferStore(pool);
  try {
    const ctx = (site: string) => ({ pageUrl: `https://${site}/r`, site, now: NOW });
    const a = normalizeJobPosting(posting({ identifier: 'A' }), ctx('tilleuls.fr'))!;
    const b = normalizeJobPosting(posting({ identifier: 'B' }), ctx('tilleuls.fr'))!;
    const c = normalizeJobPosting(posting({ identifier: 'C' }), ctx('tilleuls.fr.example'))!;
    await store.upsertOffers([a, b, c].map(toOfferRow), '2026-09-26T00:00:00Z');
    await store.upsertOffers([toOfferRow(a)], '2026-09-27T00:00:00Z');
    assert.equal(await store.deactivateUnseenSite('Sites carrière', 'tilleuls.fr', '2026-09-27T00:00:00Z'), 1, 'seule B (même site, non revue)');
    // Sites d'employeurs : site de l'entreprise ou page de candidature hébergée chez elle, hors « Sites carrière »
    const ft = (id: string, o: any) => toOfferRow({ ...a, id: `ft-${id}`, source: 'France Travail', contactEmail: undefined, ...o });
    await store.upsertOffers([
      ft('1', { companyWebsite: 'https://www.boulangerie.fr', applyUrl: 'https://candidat.francetravail.fr/1' }),
      ft('2', { companyWebsite: undefined, applyUrl: 'https://recrutement.garage-dupont.fr/offre/2' }),
      ft('3', { companyWebsite: undefined, applyUrl: 'https://fr.indeed.com/x' })
    ], '2026-09-27T00:00:00Z');
    const urls = (await store.employerUrls()).map((r) => r.url).sort();
    assert.deepEqual(urls, ['https://recrutement.garage-dupont.fr/offre/2', 'https://www.boulangerie.fr']);
    assert.deepEqual(siteSeeds(await store.employerUrls(), '').sort(), ['boulangerie.fr', 'recrutement.garage-dupont.fr']);
  } finally {
    await pool.end();
    psql(['-d', 'postgres', '-qc', `drop database if exists ${DB} with (force)`]);
  }
});
