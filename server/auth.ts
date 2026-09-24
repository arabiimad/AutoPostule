/**
 * Vérification des comptes côté serveur (Supabase Auth).
 *
 * AUTH_MODE (variable d'environnement) :
 *  - "off"      : aucune vérification (développement).
 *  - "optional" : (défaut) le jeton est vérifié s'il est présent ; limites et quotas se font alors par compte.
 *  - "required" : les routes IA exigent un compte connecté.
 *
 * Le jeton de session est validé auprès de Supabase (GET /auth/v1/user) ; le résultat est gardé
 * en cache 60 s pour ne pas interroger Supabase à chaque requête.
 */
import { createHash } from "node:crypto";

type Verifier = (token: string) => Promise<{ uid: string; email?: string }>;

const cache = new Map<string, { uid: string; email?: string; until: number }>();

function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return url && key ? { url, key } : null;
}

function getVerifier(): Verifier | null {
  const cfg = supabaseConfig();
  if (!cfg) return null;
  return async (token: string) => {
    const k = createHash("sha256").update(token).digest("hex");
    const hit = cache.get(k);
    if (hit && hit.until > Date.now()) return { uid: hit.uid, email: hit.email };
    const r = await fetch(`${cfg.url}/auth/v1/user`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000)
    });
    if (r.status === 401 || r.status === 403) throw new Error("INVALID_TOKEN");
    if (!r.ok) throw new Error(`AUTH_UNAVAILABLE_${r.status}`);
    const user: any = await r.json();
    if (!user?.id) throw new Error("INVALID_TOKEN");
    if (cache.size > 5000) cache.clear();
    cache.set(k, { uid: user.id, email: user.email, until: Date.now() + 60_000 });
    return { uid: user.id, email: user.email };
  };
}

export function getAuthMode(): "off" | "optional" | "required" {
  const m = String(process.env.AUTH_MODE || "optional").toLowerCase();
  return m === "off" || m === "required" ? m : "optional";
}

/** Middleware Express : renseigne req.uid (et req.email) si un jeton valide est fourni. */
export function authMiddleware() {
  const mode = getAuthMode();
  return async (req: any, res: any, next: any) => {
    if (mode === "off") return next();
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

    if (!token) {
      if (mode === "required") {
        return res.status(401).json({ success: false, error: "Connexion requise : connectez-vous avec votre compte pour utiliser cette fonction." });
      }
      return next();
    }

    const verify = getVerifier();
    if (!verify) {
      if (mode === "required") {
        return res.status(503).json({ success: false, error: "Vérification des comptes indisponible sur le serveur." });
      }
      return next();
    }
    try {
      const { uid, email } = await verify(token);
      req.uid = uid;
      req.email = email;
      return next();
    } catch (e: any) {
      if (String(e?.message).startsWith("AUTH_UNAVAILABLE") || e?.name === "TimeoutError") {
        // Service de comptes injoignable : on ne bloque pas en mode optional
        if (mode === "required") return res.status(503).json({ success: false, error: "Service de comptes momentanément indisponible. Réessayez." });
        return next();
      }
      return res.status(401).json({ success: false, error: "Session expirée : reconnectez-vous." });
    }
  };
}
