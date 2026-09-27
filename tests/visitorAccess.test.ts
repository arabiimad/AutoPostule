import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGatedForVisitor, OPEN_TO_VISITORS } from '../src/utils/url.ts';

test('visiteur (comptes obligatoires) : offres, tarifs et outils publics restent ouverts', () => {
  for (const tab of ['radar', 'pricing', 'ats', 'match'] as const) assert.equal(isGatedForVisitor(tab, true), false, tab);
  assert.deepEqual(OPEN_TO_VISITORS, ['radar', 'pricing', 'ats', 'match']);
});

test('visiteur : fonctions personnelles réservées aux comptes', () => {
  for (const tab of ['latex', 'kanban', 'interview', 'agent', 'profile'] as const) assert.equal(isGatedForVisitor(tab, true), true, tab);
});

test('compte connecté ou mode local : rien n\'est verrouillé', () => {
  for (const tab of ['latex', 'kanban', 'profile', 'ats'] as const) assert.equal(isGatedForVisitor(tab, false), false, tab);
});
