/**
 * Suivi des erreurs du serveur (Sentry), facultatif : actif seulement si SENTRY_DSN est défini.
 * Chargé à la demande pour ne rien coûter quand il est désactivé.
 */
type SentryLike = { captureException: (e: unknown, ctx?: any) => void; flush: (ms?: number) => Promise<boolean> };

let sentry: SentryLike | null = null;

export async function initMonitoring(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    const S: any = await import("@sentry/node");
    S.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
      release: process.env.APP_VERSION,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
      sendDefaultPii: false,
      // Pas de corps de requête (CV, profils) dans les rapports d'erreur
      beforeSend(event: any) {
        if (event.request) {
          delete event.request.data;
          delete event.request.cookies;
          if (event.request.headers) delete event.request.headers.authorization;
        }
        return event;
      }
    });
    sentry = S;
  } catch (e: any) {
    console.warn("[Sentry] initialisation impossible :", e?.message || e);
  }
}

export function captureError(error: unknown, context: Record<string, unknown> = {}) {
  try {
    sentry?.captureException(error, { extra: context });
  } catch {
    /* jamais bloquant */
  }
}

export async function flushMonitoring() {
  try {
    await sentry?.flush(2000);
  } catch { /* ignore */ }
}
