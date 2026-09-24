import { kv } from "./store.ts";

/**
 * Limiteur de débit par compte (ou IP), à fenêtre fixe. Partagé entre instances si Redis est configuré
 * (voir server/store.ts), sinon en mémoire.
 */
export function createRateLimiter(name: string, maxRequests: number, windowMs: number) {
  return async (req: any, res: any, next: any) => {
    // Compte vérifié si disponible, sinon req.ip (et non l'en-tête X-Forwarded-For brut, falsifiable)
    const who = req.uid ? `uid:${req.uid}` : `ip:${String(req.ip || "unknown")}`;
    const windowIndex = Math.floor(Date.now() / windowMs);
    try {
      const count = await kv().incr(`rl:${name}:${who}:${windowIndex}`, Math.ceil(windowMs / 1000) + 1);
      if (count > maxRequests) {
        const retry = Math.ceil(((windowIndex + 1) * windowMs - Date.now()) / 1000);
        res.setHeader("Retry-After", Math.max(1, retry));
        return res.status(429).json({ success: false, error: "Trop de requêtes. Réessayez dans une minute." });
      }
    } catch {
      /* stockage indisponible : on ne bloque pas l'utilisateur */
    }
    next();
  };
}
