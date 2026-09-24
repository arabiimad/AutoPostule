import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyAiError } from '../server/ai.ts';

test('erreur IA : jamais de JSON brut à l’écran, message clair selon la cause', () => {
  const quota = new Error('{"error":{"code":429,"message":"You exceeded your current quota ... generate_content_free_tier_requests","status":"RESOURCE_EXHAUSTED"}}');
  const msg = friendlyAiError(quota);
  assert.equal(msg, "le service d'IA a atteint sa limite d'utilisation pour le moment");
  assert.doesNotMatch(msg, /[{}"]|googleapis|gemini/i);
  assert.match(friendlyAiError(new Error('503 UNAVAILABLE')), /surchargé/);
  assert.match(friendlyAiError(new Error('SEARCH_TIMEOUT')), /trop de temps/);
  assert.match(friendlyAiError(new Error('API key not valid')), /configuration/);
  assert.match(friendlyAiError('xyz'), /n'a pas pu/);
});
