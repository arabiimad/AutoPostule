import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterJobs } from '../src/utils/jobFilter.ts';
import type { JobOffer } from '../src/types.ts';

const job = (p: Partial<JobOffer>): JobOffer => ({
  id: Math.random().toString(36), title: 'Poste', company: 'ACME', location: 'Avignon (84)', contractType: 'cdi',
  remote: 'sur-site', description: '', skillsRequired: [], source: 'test', applyUrl: 'https://x.fr', publishedAt: '2026-09-01', ...p
});

const jobs = [
  job({ title: 'Chef de projet informatique', location: 'Avignon (84)', contractType: 'alternance' }),
  job({ title: 'Chef de projet événementiel', location: 'Paris 8ème (75)' }),
  job({ title: 'Développeur React', remote: 'total', location: 'Lyon (69)' }),
  job({ title: 'Comptable', status: 'expired' })
];

test('recherche : tous les mots significatifs doivent apparaître', () => {
  const r = filterJobs(jobs, { query: 'chef de projet informatique' });
  assert.deepEqual(r.map(j => j.title), ['Chef de projet informatique']);
});

test('recherche insensible aux accents', () => {
  assert.equal(filterJobs(jobs, { query: 'evenementiel' }).length, 1);
});

test('localisation, télétravail et skipLocation', () => {
  assert.equal(filterJobs(jobs, { location: 'avignon' }).length, 2);
  assert.deepEqual(filterJobs(jobs, { location: 'Remote' }).map(j => j.title), ['Développeur React']);
  assert.equal(filterJobs(jobs, { location: 'Marseille', skipLocation: true }).length, 4);
});

test('contrat et offres expirées', () => {
  assert.equal(filterJobs(jobs, { contractType: 'alternance' }).length, 1);
  assert.equal(filterJobs(jobs, { onlyActive: true }).length, 3);
});
