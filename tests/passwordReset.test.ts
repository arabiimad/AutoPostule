import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordProblem, recoveryStateFromHash } from '../src/utils/passwordReset.ts';

test('lien de réinitialisation reconnu, lien expiré signalé, autres liens ignorés', () => {
  assert.equal(recoveryStateFromHash('#access_token=abc&expires_in=3600&refresh_token=r&token_type=bearer&type=recovery'), 'pending');
  assert.equal(recoveryStateFromHash('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'), 'expired');
  assert.equal(recoveryStateFromHash('#access_token=abc&type=signup'), null);
  assert.equal(recoveryStateFromHash('#type=recovery'), null, 'sans jeton : pas de session de réinitialisation');
  assert.equal(recoveryStateFromHash(''), null);
});

test('nouveau mot de passe : longueur, lettres et chiffres, confirmation', () => {
  assert.match(passwordProblem('abc123', 'abc123')!, /8 caractères/);
  assert.match(passwordProblem('abcdefgh', 'abcdefgh')!, /lettres et des chiffres/);
  assert.match(passwordProblem('abcdefg1', 'abcdefg2')!, /identiques/);
  assert.equal(passwordProblem('Kareer2026', 'Kareer2026'), null);
  assert.equal(passwordProblem('éléphant9', 'éléphant9'), null);
});
