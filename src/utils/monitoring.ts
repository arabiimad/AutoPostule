/**
 * Suivi des erreurs (Sentry) et mesure d'usage produit (PostHog), tous deux facultatifs :
 * actifs seulement si VITE_SENTRY_DSN / VITE_POSTHOG_KEY sont définis au build.
 *
 * Confidentialité : PostHog fonctionne sans cookie (persistance en mémoire), sans enregistrement
 * de session ni capture automatique des saisies ; aucun contenu de CV ou de lettre n'est envoyé.
 */
let sentry: any = null;
let posthog: any = null;
const queue: Array<[string, Record<string, unknown> | undefined]> = [];

export async function initClientMonitoring() {
  const env = import.meta.env;
  if (env.VITE_SENTRY_DSN) {
    try {
      const S = await import('@sentry/react');
      S.init({
        dsn: env.VITE_SENTRY_DSN,
        environment: env.MODE,
        tracesSampleRate: 0
      });
      sentry = S;
    } catch { /* facultatif */ }
  }
  if (env.VITE_POSTHOG_KEY) {
    try {
      const { default: ph } = await import('posthog-js');
      ph.init(env.VITE_POSTHOG_KEY, {
        api_host: env.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com',
        persistence: 'memory',
        person_profiles: 'identified_only',
        autocapture: false,
        capture_pageview: true,
        disable_session_recording: true,
        mask_all_text: true
      });
      posthog = ph;
      for (const [e, p] of queue.splice(0)) ph.capture(e, p);
    } catch { /* facultatif */ }
  }
}

/** Évènement produit (ex. « cv_generated »). Aucune donnée personnelle dans `props`. */
export function track(event: string, props?: Record<string, unknown>) {
  if (posthog) posthog.capture(event, props);
  else if (import.meta.env.VITE_POSTHOG_KEY && queue.length < 50) queue.push([event, props]);
}

/** Associe les évènements au compte (identifiant technique uniquement, jamais l'e-mail). */
export function identifyUser(uid: string | null, plan?: string) {
  try {
    if (uid) {
      posthog?.identify(uid, plan ? { plan } : undefined);
      sentry?.setUser({ id: uid });
    } else {
      posthog?.reset();
      sentry?.setUser(null);
    }
  } catch { /* ignore */ }
}

export function captureClientError(error: unknown) {
  try {
    sentry?.captureException(error);
  } catch { /* ignore */ }
}
