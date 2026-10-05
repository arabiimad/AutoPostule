import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGreenhouseJob, normalizeLeverJob, normalizeAshbyJob, normalizeRecruiteeJob, normalizeSmartRecruitersJob,
  normalizeWorkdayJob, workdayPostedOn, inArea, looksFrench, searchCareerSites, crawlCareerSites, careerSitesIndexStatus,
  startCareerSitesIndexer, __setCareerSitesForTests, __resetCareerSitesForTests
} from '../server/careerSites.ts';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchRealJobs, __setFetchForTests, __clearCacheForTests } from '../server/jobSources.ts';
import type { AtsCompany } from '../server/careerSitesDirectory.ts';

// Formes réelles observées le 05/10/2026 (réponses réduites)
const GH_CO: AtsCompany = { name: 'Doctolib', ats: 'greenhouse', slug: 'doctolib' };
const GH_PARIS = {
  id: 7001, title: 'Développeur Backend Ruby (F/H)', absolute_url: 'https://job-boards.greenhouse.io/doctolib/jobs/7001',
  location: { name: 'Paris, France' }, first_published: '2026-09-30T08:00:00-04:00', updated_at: '2026-10-01T08:00:00-04:00',
  metadata: [{ name: 'Employment Type', value: 'CDI' }], departments: [{ name: 'Engineering' }],
  content: '&lt;p&gt;Rejoignez l&amp;#39;équipe &lt;strong&gt;Ruby on Rails&lt;/strong&gt;&amp;nbsp;!&lt;/p&gt;'
};
const GH_BERLIN = { ...GH_PARIS, id: 7002, location: { name: 'Berlin, Germany' }, metadata: [{ name: 'Job Posting Country', value: 'Germany' }], offices: [{ name: 'Berlin HQ', location: 'Berlin, Germany' }] };

const LEVER_CO: AtsCompany = { name: 'Qonto', ats: 'lever', slug: 'qonto' };
const LEVER = {
  id: 'ee6d81ef', text: 'Product Designer - Internship', hostedUrl: 'https://jobs.lever.co/qonto/ee6d81ef', country: 'FR', workplaceType: 'hybrid',
  createdAt: 1759500000000, categories: { commitment: 'Internship', department: 'Product', location: 'Paris', allLocations: ['Paris'] },
  descriptionPlain: 'Our journey: an early stage mindset.', lists: [{ text: 'What you will do', content: '<li>Figma</li>' }], additionalPlain: 'Benefits'
};

const ASHBY_CO: AtsCompany = { name: 'Alan', ats: 'ashby', slug: 'alan' };
const ASHBY = {
  id: 'a1', title: 'Data Engineer', jobUrl: 'https://jobs.ashbyhq.com/alan/a1', employmentType: 'FullTime', location: 'Paris', isListed: true,
  isRemote: null, workplaceType: 'Hybrid', address: { postalAddress: { addressCountry: 'France', addressLocality: 'Paris' } },
  publishedAt: '2026-10-01T10:00:00.000+00:00', descriptionPlain: 'Python, SQL, dbt', department: 'Data'
};

const SR_CO: AtsCompany = { name: 'Ubisoft', ats: 'smartrecruiters', slug: 'Ubisoft2' };
const SR = {
  id: '744000153206238', name: 'Trade Marketing Assistant – Internship (6-month)', releasedDate: '2026-10-02T14:43:11.124Z',
  location: { city: 'Paris', region: 'IDF', country: 'fr', remote: false, hybrid: true, latitude: '48.8575475', longitude: '2.3513765', fullLocation: 'Paris, IDF, France' },
  function: { label: 'Sales' }, department: { label: 'Ubisoft' }, typeOfEmployment: { id: 'intern', label: 'Intern' }, experienceLevel: { label: 'Not Applicable' }
};

const WD_CO: AtsCompany = { name: 'Airbus', ats: 'workday', slug: 'ag', workday: { host: 'ag.wd3', site: 'Airbus' } };
const WD = { title: 'Stage 2027 - Ingénieur logiciel', externalPath: '/job/Toulouse-Area/Stage-2027_JR10441188', locationsText: 'Toulouse Area', postedOn: 'Posted 3 Days Ago', bulletFields: ['JR10441188'] };

const ok = (b: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => b, text: async () => (typeof b === 'string' ? b : JSON.stringify(b)) });

beforeEach(() => {
  __clearCacheForTests();
  __resetCareerSitesForTests();
  delete process.env.ATS_SOURCES;
  delete process.env.ATS_COMPANIES_FILE;
  for (const k of ['LBA_API_KEY', 'FT_CLIENT_ID', 'FT_CLIENT_SECRET', 'JSEARCH_API_KEY', 'ADZUNA_APP_ID', 'ADZUNA_APP_KEY', 'JOOBLE_API_KEY']) delete process.env[k];
});

test('Greenhouse : HTML échappé décodé, offres hors France écartées', () => {
  const j = normalizeGreenhouseJob(GH_PARIS, GH_CO)!;
  assert.equal(j.id, 'ats-greenhouse-doctolib-7001');
  assert.equal(j.origin, 'site-carriere');
  assert.equal(j.company, 'Doctolib');
  assert.match(j.source, /^Site carrière Doctolib/);
  assert.equal(j.description, "Rejoignez l'équipe Ruby on Rails !");
  assert.equal(j.contractType, 'cdi');
  assert.equal(j.applyUrl, GH_PARIS.absolute_url);
  assert.equal(j.domain, 'Engineering');
  assert.equal(normalizeGreenhouseJob(GH_BERLIN, GH_CO), null);
});

test('Lever : stage lu dans le type de contrat, pas dans « early stage » du texte', () => {
  const j = normalizeLeverJob(LEVER, LEVER_CO)!;
  assert.equal(j.contractType, 'stage');
  assert.equal(j.remote, 'hybride');
  assert.match(j.description, /What you will do\n• Figma/);
  const cdi = normalizeLeverJob({ ...LEVER, text: 'Product Designer', categories: { ...LEVER.categories, commitment: 'Full-time' } }, LEVER_CO)!;
  assert.equal(cdi.contractType, 'cdi', '« early stage » dans la description ne fait pas un stage');
  assert.equal(normalizeLeverJob({ ...LEVER, country: 'ES', categories: { ...LEVER.categories, location: 'Madrid', allLocations: ['Madrid'] } }, LEVER_CO), null);
});

test('Ashby, Recruitee, SmartRecruiters, Workday', () => {
  const a = normalizeAshbyJob(ASHBY, ASHBY_CO)!;
  assert.equal(a.remote, 'hybride');
  assert.ok(a.skillsRequired.includes('Python'));
  assert.equal(normalizeAshbyJob({ ...ASHBY, address: { postalAddress: { addressCountry: 'Belgium' } }, location: 'Anywhere in Belgium' }, ASHBY_CO), null);

  const r = normalizeRecruiteeJob({ id: 9, title: 'Account Executive', careers_url: 'https://jobs.livestorm.co/o/ae', city: 'Paris', country_code: 'FR', remote: true, employment_type_code: 'fulltime_permanent', published_at: '2026-05-28 13:33:37 UTC' }, { name: 'Livestorm', ats: 'recruitee', slug: 'livestorm' })!;
  assert.equal(r.remote, 'total');
  assert.equal(r.publishedAt, '2026-05-28T13:33:37.000Z');

  const s = normalizeSmartRecruitersJob(SR, SR_CO)!;
  assert.equal(s.contractType, 'stage');
  assert.equal(s.remote, 'hybride');
  assert.equal(s.descriptionIsSnippet, true);
  assert.equal(s.latitude, 48.8575475);
  assert.equal(s.applyUrl, 'https://jobs.smartrecruiters.com/Ubisoft2/744000153206238');

  const now = Date.parse('2026-10-05T12:00:00Z');
  const w = normalizeWorkdayJob(WD, WD_CO, now)!;
  assert.equal(w.contractType, 'stage');
  assert.equal(w.applyUrl, 'https://ag.wd3.myworkdayjobs.com/Airbus/job/Toulouse-Area/Stage-2027_JR10441188');
  assert.equal(w.id, 'ats-workday-ag-JR10441188');
  assert.equal(w.publishedAt, '2026-10-02T12:00:00.000Z');
  assert.equal(workdayPostedOn('Posted 30+ Days Ago', now), '2026-09-05T12:00:00.000Z');
  assert.equal(normalizeWorkdayJob({ ...WD, locationsText: '3 Locations' }, WD_CO)!.location, 'France (plusieurs sites)');
});

test('zone : distance, ville, Île-de-France, télétravail total', () => {
  const job = (location: string, extra: any = {}) => ({ ...normalizeAshbyJob({ ...ASHBY, location }, ASHBY_CO)!, location, ...extra });
  const lyon = { label: 'Lyon', latitude: 45.76, longitude: 4.83, departement: '69' };
  assert.equal(inArea(job('Lyon'), lyon), true);
  assert.equal(inArea(job('Paris'), lyon), false);
  assert.equal(inArea(job('Paris', { remote: 'total' }), lyon), true);
  assert.equal(inArea(job('Paris Area'), { label: 'Boulogne-Billancourt', departement: '92' }), true);
  assert.equal(inArea(job('X', { latitude: 48.85, longitude: 2.35 }), { label: 'Versailles', latitude: 48.80, longitude: 2.13 }, 30), true);
  assert.equal(inArea(job('Lyon'), null), true);
  assert.equal(looksFrench('Toulouse Area'), true);
  assert.equal(looksFrench('Berlin, Germany'), false);
});

const DIRECTORY: AtsCompany[] = [
  GH_CO, LEVER_CO, ASHBY_CO, SR_CO, WD_CO,
  { name: 'Livestorm', ats: 'recruitee', slug: 'livestorm' },
  { name: 'Ornikar', ats: 'teamtailor', slug: 'ornikar' },
  { name: 'Swiss Life France', ats: 'workday', slug: 'swisslife', workday: { host: 'swisslife.wd3', site: 'FR', countryFacet: 'none' } }
];

const TT_RSS = `<?xml version="1.0"?><rss xmlns:tt="https://teamtailor.com/locations"><channel><title>Ornikar</title>
<item><title>Business Analyst - Alternance</title><description>&lt;p&gt;Rejoignez-nous&lt;/p&gt;</description><pubDate>Mon, 05 Oct 2026 09:00:00 +0200</pubDate>
<link>https://ornikar.teamtailor.com/jobs/1-ba</link><remoteStatus>none</remoteStatus><guid>g1</guid>
<tt:locations><tt:location><tt:city>Paris</tt:city><tt:country>France</tt:country></tt:location></tt:locations><tt:department>Data</tt:department></item>
<item><title>Sales UK</title><link>https://ornikar.teamtailor.com/jobs/2-uk</link><guid>g2</guid>
<tt:locations><tt:location><tt:city>London</tt:city><tt:country>United Kingdom</tt:country></tt:location></tt:locations></item>
</channel></rss>`;

/** Faux serveurs des ATS : chaque appel est enregistré. */
function mockAts(calls: { url: string; body?: any }[], overrides: (url: string) => any = () => undefined) {
  __setFetchForTests(async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const o = overrides(url);
    if (o) return o;
    if (url.includes('greenhouse')) return ok({ jobs: [GH_PARIS, GH_BERLIN, { ...GH_PARIS, id: 7003, title: 'Account Executive' }] });
    if (url.includes('lever.co')) return ok([{ ...LEVER, text: 'Développeur Backend Go', categories: { ...LEVER.categories, commitment: 'CDI' } }]);
    if (url.includes('ashbyhq')) return ok({ jobs: [ASHBY] });
    if (url.includes('recruitee')) return ok({ offers: [] });
    if (url.includes('teamtailor')) return ok(TT_RSS);
    if (url.includes('smartrecruiters')) {
      const offset = Number(new URL(url).searchParams.get('offset'));
      // 150 offres : deux pages de 100
      const page = Array.from({ length: offset === 0 ? 100 : 50 }, (_, i) => ({ ...SR, id: String(offset + i) }));
      return ok({ totalFound: 150, content: page });
    }
    if (url.includes('myworkdayjobs')) return ok({ total: 1, jobPostings: [WD] });
    throw new Error(`URL inattendue ${url}`);
  });
}

test('index : tous les ATS parcourus (pagination, filtre France), puis recherche en mémoire', async () => {
  process.env.ATS_INDEX_FILE = 'off';
  __setCareerSitesForTests(DIRECTORY);
  const calls: { url: string; body?: any }[] = [];
  mockAts(calls);
  await crawlCareerSites();

  const status = careerSitesIndexStatus();
  assert.equal(status.indexed, DIRECTORY.length);
  assert.equal(status.failed, 0);
  // Greenhouse 1 (Berlin écartée, Account Executive gardée) + 1 ; Lever 1 ; Ashby 1 ; SR 150 ; Workday 1 + 1 ; Teamtailor 1
  assert.equal(status.jobs, 2 + 1 + 1 + 150 + 1 + 1 + 1);
  assert.equal(calls.filter((c) => c.url.includes('smartrecruiters')).length, 2, 'SmartRecruiters : 2 pages');
  const wd = calls.filter((c) => c.url.includes('myworkdayjobs'));
  assert.deepEqual(wd.find((c) => c.url.includes('ag.wd3'))!.body.appliedFacets, { locationCountry: ['54c5b6971ffb4bf0b116fe7651ec789a'] });
  assert.deepEqual(wd.find((c) => c.url.includes('swisslife'))!.body.appliedFacets, {}, 'site 100 % France : pas de filtre pays');

  // La recherche ne refait aucun appel : elle filtre l'index
  calls.length = 0;
  const r = await searchCareerSites({ query: 'développeur backend' }, null);
  assert.equal(calls.length, 0);
  assert.deepEqual(r.jobs.map((j) => j.id).sort(), ['ats-greenhouse-doctolib-7001', 'ats-lever-qonto-ee6d81ef']);
  assert.equal(r.indexing, false);

  const stages = await searchCareerSites({ query: '', contractType: 'alternance' }, null);
  assert.deepEqual(stages.jobs.map((j) => j.company), ['Ornikar']);
  assert.equal(stages.jobs[0].description, 'Rejoignez-nous');
});

test('index : un site en panne garde ses offres connues et est réessayé', async () => {
  process.env.ATS_INDEX_FILE = 'off';
  __setCareerSitesForTests([GH_CO, ASHBY_CO]);
  const calls: { url: string }[] = [];
  mockAts(calls);
  await crawlCareerSites();
  assert.equal(careerSitesIndexStatus().jobs, 3);

  mockAts(calls, (url) => (url.includes('ashbyhq') ? ok({}, 503) : undefined));
  await crawlCareerSites(true);
  const s = careerSitesIndexStatus();
  assert.equal(s.failed, 1);
  assert.equal(s.jobs, 3, 'les offres Ashby déjà connues restent visibles');
});

test('index sauvegardé sur disque et rechargé au démarrage', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ats-')), 'index.json');
  process.env.ATS_INDEX_FILE = file;
  __setCareerSitesForTests([GH_CO]);
  mockAts([]);
  await crawlCareerSites();
  assert.ok(existsSync(file));

  __resetCareerSitesForTests();
  __setCareerSitesForTests([GH_CO]);
  const calls: { url: string }[] = [];
  mockAts(calls);
  startCareerSitesIndexer();
  const r = await searchCareerSites({ query: 'ruby' }, null);
  assert.equal(r.jobs.length, 1, 'offres disponibles tout de suite, depuis le disque');
  assert.equal(calls.length, 0, 'index récent : pas de nouveau parcours');
  __resetCareerSitesForTests();
});

test('searchRealJobs : sites carrières actifs sans clé, désactivables, offre officielle prioritaire', async () => {
  process.env.ATS_INDEX_FILE = 'off';
  __setCareerSitesForTests([GH_CO, LEVER_CO]);
  mockAts([]);
  const r = await searchRealJobs({ query: 'développeur backend', contractType: 'cdi' });
  assert.equal(r.sources.careerSites.enabled, true);
  assert.equal(r.sources.careerSites.count, 2);
  assert.equal(r.jobs[0].origin, 'site-carriere');

  const p2 = await searchRealJobs({ query: 'développeur backend', page: 2 });
  assert.ok(p2.sources.careerSites.skipped);

  process.env.ATS_SOURCES = 'off';
  const off = await searchRealJobs({ query: 'développeur backend' });
  assert.equal(off.sources.careerSites.enabled, false);
  __resetCareerSitesForTests();
});
