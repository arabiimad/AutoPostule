import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeJSearchJob, normalizeAdzunaJob, normalizeJoobleJob, mergeDuplicates, inferContract, inferRemote,
  searchRealJobs, __setFetchForTests, __clearCacheForTests
} from '../server/jobSources.ts';

const JS = {
  job_id: 'abc==', job_title: 'Développeur React H/F', employer_name: 'Studio Pixel', employer_logo: 'https://logo.png',
  job_publisher: 'LinkedIn', job_employment_type: 'FULLTIME', job_apply_link: 'https://linkedin.com/jobs/1',
  apply_options: [{ publisher: 'LinkedIn', apply_link: 'https://linkedin.com/jobs/1' }, { publisher: 'Welcome to the Jungle', apply_link: 'https://wttj.com/j/1' }],
  job_description: 'CDI – React, TypeScript. Télétravail 2 jours par semaine.', job_is_remote: false,
  job_posted_at_datetime_utc: '2026-09-20T10:00:00.000Z', job_city: 'Avignon', job_state: "Provence-Alpes-Côte d'Azur",
  job_min_salary: 38000, job_max_salary: 45000, job_salary_period: 'YEAR'
};
const ADZ = {
  id: '42', title: '<strong>Développeur</strong> React', description: 'Nous cherchons un développeur React (alternance)…',
  company: { display_name: 'Studio Pixel' }, location: { display_name: 'Avignon, Vaucluse' }, created: '2026-09-19T08:00:00Z',
  redirect_url: 'https://www.adzuna.fr/details/42', contract_type: 'permanent', salary_min: 30000, salary_max: 30000, salary_is_predicted: '0'
};
const JBL = { id: 7, title: 'Développeur React H/F', company: 'Studio Pixel', location: 'Avignon', snippet: '&nbsp;...React <b>TypeScript</b>...', salary: '', source: 'indeed.fr', type: 'CDI', link: 'https://jooble.org/desc/7', updated: '2026-09-18T00:00:00.000' };

beforeEach(() => {
  __clearCacheForTests();
  process.env.ATS_SOURCES = 'off'; // sites carrières : testés dans careerSites.test.ts
  for (const k of ['LBA_API_KEY', 'FT_CLIENT_ID', 'FT_CLIENT_SECRET', 'JSEARCH_API_KEY', 'ADZUNA_APP_ID', 'ADZUNA_APP_KEY', 'JOOBLE_API_KEY']) delete process.env[k];
});

test('JSearch (LinkedIn / WTTJ / Indeed via Google Jobs)', () => {
  const j = normalizeJSearchJob(JS)!;
  assert.equal(j.source, 'LinkedIn');
  assert.equal(j.contractType, 'cdi');
  assert.equal(j.remote, 'hybride');
  assert.match(j.salary || '', /38.?000 € – 45.?000 € \/ an/);
  assert.equal(j.applyOptions?.length, 2);
  assert.equal(j.companyLogo, 'https://logo.png');
  assert.ok(j.skillsRequired.includes('React'));
});

test('Adzuna : HTML retiré, extrait signalé, contrat déduit du texte', () => {
  const j = normalizeAdzunaJob(ADZ)!;
  assert.equal(j.title, 'Développeur React');
  assert.equal(j.descriptionIsSnippet, true);
  assert.equal(j.contractType, 'alternance');
  assert.match(j.salary || '', /30/);
});

test('Jooble : source d\'origine conservée', () => {
  const j = normalizeJoobleJob(JBL)!;
  assert.equal(j.source, 'indeed.fr (via Jooble)');
  assert.equal(j.description, '...React TypeScript...');
});

test('inférences prudentes', () => {
  assert.equal(inferContract('Stage de fin d\'études'), 'stage');
  assert.equal(inferContract('Apprenti développeur'), 'alternance');
  assert.equal(inferContract('Développeur', 'cdd'), 'cdd');
  assert.equal(inferContract('Mission freelance possible', 'cdi', 'Développeur web (CDI)'), 'cdi', "l'intitulé prime");
  assert.equal(inferRemote('Poste sur site à Lyon'), 'non-precise');
  assert.equal(inferRemote('Full remote possible'), 'total');
});

test('fusion des doublons multi-sources', () => {
  const merged = mergeDuplicates([normalizeJSearchJob(JS)!, normalizeAdzunaJob({ ...ADZ, description: 'CDI React' })!, normalizeJoobleJob(JBL)!]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'LinkedIn');
  assert.ok((merged[0].alsoOn || []).some(a => a.source === 'Adzuna'));
  assert.ok((merged[0].alsoOn || []).some(a => /jooble/i.test(a.source)));
  assert.ok((merged[0].applyOptions || []).some(a => a.publisher === 'Welcome to the Jungle'));
});

test('recherche multi-sources : quotas protégés sans mot-clé, filtrage du contrat', async () => {
  process.env.JSEARCH_API_KEY = 'k'; process.env.ADZUNA_APP_ID = 'i'; process.env.ADZUNA_APP_KEY = 'k'; process.env.JOOBLE_API_KEY = 'k';
  const calls: string[] = [];
  __setFetchForTests(async (url, init) => {
    calls.push(url);
    const ok = (b: any) => ({ ok: true, status: 200, json: async () => b, text: async () => '' });
    if (url.includes('adzuna')) return ok({ results: [ADZ, { ...ADZ, id: '43', title: 'Comptable CDI', description: 'CDI comptable' }] });
    if (url.includes('rapidapi')) { assert.equal(init.headers['X-RapidAPI-Key'], 'k'); return ok({ data: [JS] }); }
    if (url.includes('jooble')) { assert.match(String(init.body), /"keywords":"développeur"/); return ok({ jobs: [JBL] }); }
    throw new Error(url);
  });
  const r0 = await searchRealJobs({});
  assert.ok(r0.sources.jsearch.skipped && r0.sources.jooble.skipped);
  assert.ok(!calls.some(u => u.includes('rapidapi') || u.includes('jooble')));

  const r1 = await searchRealJobs({ query: 'développeur', contractType: 'cdi' });
  assert.equal(r1.sources.jsearch.count, 1);
  assert.ok(r1.jobs.every(j => j.contractType === 'cdi'));
  // Offre Adzuna sans rapport avec « développeur » : écartée par le filtre de pertinence
  assert.ok(!r1.jobs.some(j => j.title === 'Comptable CDI'));
  assert.ok(r1.jobs.length >= 1);
});
