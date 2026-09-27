/**
 * Erreurs du service IA → messages pour le candidat.
 * Le détail technique (JSON de Google, modèle, quota) reste dans les journaux du serveur, jamais à l'écran.
 */

export function isRateLimitOrQuotaError(error: unknown): boolean {
  if (!error) return false;
  const e: any = error;
  const str = String(e?.message || e?.status || e?.code || e);
  return /429|503|RESOURCE_EXHAUSTED|UNAVAILABLE|quota|high demand|rate-limits|rate limit|overloaded/i.test(str);
}

/** Message affiché quand l'adaptation IA du CV a échoué (le CV est alors construit à partir du profil). */
export function tailorFailureNotice(error: unknown): string {
  return isRateLimitOrQuotaError(error)
    ? "L'assistant IA est très sollicité en ce moment : votre CV a été construit à partir de votre profil, sans reformulation. Réessayez dans quelques minutes avec « Régénérer avec l'IA »."
    : "L'assistant IA n'a pas pu adapter votre CV : il a été construit à partir de votre profil, sans reformulation. Réessayez avec « Régénérer avec l'IA ».";
}

/** Résumé court et sans donnée personnelle d'une erreur IA, pour les journaux. */
export function aiErrorSummary(error: unknown): string {
  const e: any = error;
  const raw = String(e?.message || e || "");
  const code = raw.match(/"code"\s*:\s*(\d{3})/)?.[1] || (e?.status ? String(e.status) : "");
  const status = raw.match(/"status"\s*:\s*"([A-Z_]+)"/)?.[1] || "";
  return [code, status].filter(Boolean).join(" ") || raw.slice(0, 120);
}
