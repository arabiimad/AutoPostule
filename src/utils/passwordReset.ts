/**
 * Réinitialisation du mot de passe : lecture du lien reçu par e-mail et règles du nouveau mot de passe.
 */
export type RecoveryState = 'pending' | 'expired';

/**
 * Lien « mot de passe oublié » :
 *   #access_token=…&type=recovery                 → choisir un nouveau mot de passe
 *   #error=access_denied&error_code=otp_expired…  → lien expiré ou déjà utilisé
 */
export function recoveryStateFromHash(hash: string): RecoveryState | null {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  if (p.get('type') === 'recovery' && p.get('access_token')) return 'pending';
  if (/otp_expired|access_denied/.test(`${p.get('error_code') || ''} ${p.get('error') || ''}`)) return 'expired';
  return null;
}

/** Même règle que l'inscription : 8 caractères minimum, avec lettres et chiffres. */
export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < 8) return 'Le mot de passe doit contenir au moins 8 caractères.';
  if (!/[A-Za-zÀ-ÿ]/.test(password) || !/\d/.test(password)) return 'Le mot de passe doit contenir des lettres et des chiffres.';
  if (password !== confirm) return 'Les deux mots de passe ne sont pas identiques.';
  return null;
}
