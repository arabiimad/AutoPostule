import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStarLocally } from '../server/starCheck.ts';

test('STAR complet et chiffré : bonne note, rien de réécrit', () => {
  const r = evaluateStarLocally("En 2022, chez Studio X, l'équipe devait livrer une API en 3 semaines. Mon rôle était de coordonner le développement. J'ai découpé le travail en lots et j'ai mis en place des tests automatisés. Résultat : livraison à temps et 30 % de bugs en moins.");
  assert.equal(r.source, 'local-heuristic');
  assert.ok(r.starBreakdown.situation && r.starBreakdown.task && r.starBreakdown.action && r.starBreakdown.result, JSON.stringify(r.starBreakdown));
  assert.ok(r.score >= 8, String(r.score));
  assert.equal(r.improvedSample, '');
});

test('réponse vague : note basse et conseils', () => {
  const r = evaluateStarLocally('Je suis motivé et je travaille bien en équipe.');
  assert.ok(r.score <= 4, String(r.score));
  assert.ok(r.improvements.length >= 3);
});
