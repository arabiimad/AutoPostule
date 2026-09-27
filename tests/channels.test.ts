import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveApplyChannel, findApplicationEmail, isAutomatable } from '../server/automation/channels.ts';

test('Lever et Greenhouse reconnus (URL de candidature exacte)', () => {
  const lever = resolveApplyChannel({ applyUrl: 'https://jobs.lever.co/acme/0b5c3a9e-1111-4a2b-9c3d-123456789abc' });
  assert.deepEqual([lever.kind, lever.target], ['lever', 'https://jobs.lever.co/acme/0b5c3a9e-1111-4a2b-9c3d-123456789abc/apply']);
  const gh = resolveApplyChannel({ url: 'https://www.linkedin.com/jobs/view/1', applyOptions: [{ url: 'https://job-boards.greenhouse.io/acme/jobs/4012345' }] });
  assert.deepEqual([gh.kind, gh.target], ['greenhouse', 'https://job-boards.greenhouse.io/acme/jobs/4012345']);
});

test('adresse de candidature publiée dans l’offre, avec l’extrait qui le prouve', () => {
  const c = resolveApplyChannel({ applyUrl: 'https://fr.indeed.com/viewjob?jk=1', description: 'Poste en CDI. Envoyez votre CV et lettre de motivation à recrutement@acme.fr avant le 30 juin.' });
  assert.equal(c.kind, 'email');
  assert.equal(c.target, 'recrutement@acme.fr');
  assert.match((c as any).evidence, /Envoyez votre CV/);
  assert.equal(resolveApplyChannel({ applyUrl: 'mailto:jobs@acme.fr?subject=Candidature' }).target, 'jobs@acme.fr');
});

test('adresses écartées : sans lien avec la candidature, ou jamais utilisables', () => {
  assert.equal(findApplicationEmail('Pour toute question sur nos produits : contact@acme.fr'), null);
  assert.equal(findApplicationEmail('Envoyez votre CV à noreply@acme.fr'), null);
  assert.equal(findApplicationEmail('Données personnelles : dpo@acme.fr'), null);
  assert.equal(findApplicationEmail('Vous pouvez écrire à rh@acme.fr')?.email, 'rh@acme.fr');
});

test('LinkedIn, Indeed, WTTJ : validation manuelle, jamais d’envoi automatique', () => {
  for (const url of ['https://www.linkedin.com/jobs/view/1', 'https://fr.indeed.com/viewjob?jk=2', 'https://www.welcometothejungle.com/fr/companies/x/jobs/y']) {
    const c = resolveApplyChannel({ applyUrl: url });
    assert.equal(c.kind, 'platform', url);
    assert.equal(isAutomatable(c, ['email', 'form']), false);
  }
  assert.equal(resolveApplyChannel({ applyUrl: 'https://careers.acme.fr/offre/12' }).kind, 'unknown');
});

test('canaux autorisés par le candidat respectés', () => {
  const email = resolveApplyChannel({ description: 'Candidatures : jobs@acme.fr' });
  assert.equal(isAutomatable(email, ['form']), false);
  assert.equal(isAutomatable(email, ['email']), true);
});
