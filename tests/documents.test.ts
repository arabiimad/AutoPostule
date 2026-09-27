import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLetterFacts, autonomousReadiness, type PreparedCv } from '../server/services/documents.ts';
import { fallbackOfferAnalysis } from '../server/cvPipeline.ts';

const candidate = {
  fullName: 'Karim Dupont', title: 'Développeur', skills: ['React', 'Node.js'],
  experiences: [{ company: 'Studio X', title: 'Développeur', startDate: '2021', bullets: ['Développement React pour 12 clients'] }]
};
const job = { title: 'Développeur React', company: 'Mistral 3D', skillsRequired: ['React', 'Kubernetes'] };
const cv = (over: Partial<PreparedCv> = {}): PreparedCv => ({
  tailored: { headline: 'Développeur', summary: '', experiences: [], skillsOrder: [], highlights: [] },
  analysis: fallbackOfferAnalysis(job), rejected: [], source: 'ai', reviewed: true, far: false, notices: [], models: [], ...over
});
const honest = 'Madame, Monsieur,\n\nChez Studio X, j’ai développé en React pour 12 clients.\n\nJe serais ravi d’échanger avec Mistral 3D.\n\nKarim Dupont';

test('lettre fidèle au profil : aucun problème (chiffres de l’entreprise et dates tolérés)', () => {
  assert.deepEqual(checkLetterFacts(honest + '\nLe 12/03/2026', candidate, job), []);
});

test('lettre avec chiffre ou compétence inventés : signalée', () => {
  const p = checkLetterFacts('J’ai géré 40 projets.\n\nJe maîtrise Kubernetes.', candidate, job);
  assert.ok(p.some(r => /40/.test(r)), p.join());
  assert.ok(p.some(r => /kubernetes/i.test(r)), p.join());
});

test('envoi sans intervention : autorisé seulement si toutes les vérifications passent', () => {
  assert.equal(autonomousReadiness(cv(), { source: 'ai', letter: honest }, candidate, job).ok, true);
  assert.equal(autonomousReadiness(cv({ reviewed: false }), { source: 'ai', letter: honest }, candidate, job).ok, false);
  assert.equal(autonomousReadiness(cv({ far: true }), { source: 'ai', letter: honest }, candidate, job).ok, false);
  assert.equal(autonomousReadiness(cv(), { source: 'template', letter: honest }, candidate, job).ok, false);
  assert.equal(autonomousReadiness(cv(), { source: 'ai', letter: 'J’ai 10 ans d’expérience.' }, candidate, job).ok, false);
  // CV du profil tel quel (sans IA) : aucune reformulation, donc pas de relecture nécessaire
  assert.equal(autonomousReadiness(cv({ source: 'profile', reviewed: false }), { source: 'ai', letter: honest }, candidate, job).ok, true);
});
