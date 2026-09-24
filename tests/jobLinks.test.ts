import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApplyUrl, getCompanyOfficialPortal } from '../src/utils/jobLinks.ts';

test('portail officiel : correspondance sur le début du nom uniquement', () => {
  assert.equal(getCompanyOfficialPortal('Leroy Merlin'), null);
  assert.match(getCompanyOfficialPortal('EY Consulting') || '', /ey\.com/);
  assert.match(getCompanyOfficialPortal('Publicis Groupe') || '', /Publicis/);
});

test("lien de candidature : l'URL de l'offre, sauf page de recherche générique", () => {
  const base = { title: 'Dev', contractType: 'cdi' as const };
  assert.equal(getApplyUrl({ ...base, company: 'Inconnue', applyUrl: 'https://jobs.example.org/42' }), 'https://jobs.example.org/42');
  assert.match(getApplyUrl({ ...base, company: 'Sanofi', applyUrl: 'https://fr.indeed.com/emplois?q=x' }), /sanofi\.fr/);
  assert.match(getApplyUrl({ ...base, company: 'Inconnue', applyUrl: '' }), /indeed/);
  assert.match(getApplyUrl({ ...base, company: 'Inconnue', applyUrl: 'https://example.com/fake' }), /indeed/);
});
