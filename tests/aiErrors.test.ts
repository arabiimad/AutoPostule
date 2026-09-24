import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimitOrQuotaError, tailorFailureNotice, aiErrorSummary } from '../server/aiErrors.ts';

// Erreur réelle renvoyée par Gemini quand le quota gratuit est épuisé
const quota = new Error(JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.5-flash', status: 'RESOURCE_EXHAUSTED' } }));

test('erreur IA : message clair en français, sans détail technique', () => {
  assert.ok(isRateLimitOrQuotaError(quota));
  const notice = tailorFailureNotice(quota);
  assert.match(notice, /très sollicité/);
  assert.match(notice, /construit à partir de votre profil/);
  assert.doesNotMatch(notice, /[{}"]|googleapis|RESOURCE_EXHAUSTED|429|gemini|quota|billing/i);
  const other = tailorFailureNotice(new Error('INVALID_ARGUMENT: bad schema'));
  assert.doesNotMatch(other, /INVALID_ARGUMENT|schema/);
  assert.match(other, /n'a pas pu adapter votre CV/);
});

test('erreur IA : résumé court pour les journaux', () => {
  assert.equal(aiErrorSummary(quota), '429 RESOURCE_EXHAUSTED');
  assert.equal(aiErrorSummary({ status: 503, message: 'overloaded' }), '503');
});
