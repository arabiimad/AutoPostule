import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCandidateMatch, candidateHasSkill, skillAlternatives } from '../src/utils/skillMatcher.ts';

test('score = part des compétences couvertes, sans plancher', () => {
  assert.equal(calculateCandidateMatch([], ['Python']).score, 0);
  assert.equal(calculateCandidateMatch(['Python'], ['Python', 'SQL']).score, 50);
  assert.equal(calculateCandidateMatch(['Python', 'SQL'], ['python', 'sql']).score, 100);
});

test('offre sans compétences listées : score non évaluable (null)', () => {
  assert.equal(calculateCandidateMatch(['Python'], []).score, null);
});

test('limites de mots : Java ≠ JavaScript, JavaScript ≠ Node.js', () => {
  assert.equal(candidateHasSkill(['Java'], 'JavaScript'), false);
  assert.equal(candidateHasSkill(['JavaScript'], 'Node.js'), false);
});

test('un mot générique ne valide pas une compétence plus précise', () => {
  assert.equal(candidateHasSkill(['Gestion'], 'Gestion prestataires'), false);
  assert.equal(candidateHasSkill(['Gestion de projet IT'], 'Gestion de projet'), true);
});

test('accents et casse ignorés, synonymes reconnus', () => {
  assert.equal(candidateHasSkill(['methodologies agiles'], 'Méthodologies Agiles'), true);
  assert.equal(candidateHasSkill(['Microsoft Office'], 'Pack Office'), true);
  assert.equal(candidateHasSkill(['JS'], 'JavaScript'), true);
});

test('compétences composées : une alternative suffit', () => {
  assert.deepEqual(skillAlternatives('C# / .NET'), ['C# / .NET', 'C#', '.NET']);
  assert.equal(candidateHasSkill(['InDesign'], 'Suite Adobe (Photoshop, Illustrator, InDesign)'), true);
  assert.equal(candidateHasSkill(['Agile'], 'Méthodologie Agile / Scrum'), true);
  assert.equal(candidateHasSkill(['Python'], 'Docker & Kubernetes'), false);
});
