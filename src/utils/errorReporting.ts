/**
 * Remonte les erreurs JavaScript du navigateur au serveur (/api/client-errors), qui les journalise.
 * Dédoublonnage et plafond par session pour ne jamais inonder le serveur.
 */
const sent = new Set<string>();
let count = 0;
const MAX_PER_SESSION = 10;

function report(message: string, stack?: string) {
  const key = `${message}|${(stack || '').slice(0, 200)}`;
  if (!message || sent.has(key) || count >= MAX_PER_SESSION) return;
  sent.add(key);
  count++;
  const body = JSON.stringify({ message: message.slice(0, 500), stack: (stack || '').slice(0, 2000), url: window.location.pathname + window.location.search });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/client-errors', new Blob([body], { type: 'application/json' }));
    } else {
      fetch('/api/client-errors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch {
    /* jamais bloquant */
  }
}

export function installErrorReporting() {
  window.addEventListener('error', (e) => report(e.message || String(e.error), e.error?.stack));
  window.addEventListener('unhandledrejection', (e) => {
    const r: any = e.reason;
    // Les erreurs réseau attendues (hors ligne, requête annulée) ne sont pas des bugs
    if (r?.name === 'AbortError' || /Failed to fetch|NetworkError|Load failed/i.test(String(r?.message || r))) return;
    report(String(r?.message || r), r?.stack);
  });
}

export function reportError(error: unknown) {
  const e: any = error;
  report(String(e?.message || e), e?.stack);
}
