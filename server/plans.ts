/**
 * Forfaits (freemium) et quotas mensuels par type d'action IA.
 *
 * - Gratuit : quelques générations par mois, modèle rapide (Flash).
 * - Premium : usage « raisonnable » élevé, modèle le plus puissant (Pro) pour le CV et la lettre.
 *
 * Les compteurs sont tenus côté serveur : table `usage` (Supabase) pour les comptes,
 * stockage clé-valeur (mémoire ou Redis) par adresse IP pour les visiteurs sans compte.
 */
import { kv } from "./store.ts";
import { logEvent } from "./log.ts";

export type PlanId = "free" | "premium";
export type QuotaKind = "cv" | "letter" | "rewrite" | "interview" | "import";

export const QUOTA_LABELS: Record<QuotaKind, string> = {
  cv: "CV adaptés par l'IA",
  letter: "lettres de motivation",
  rewrite: "retouches IA",
  interview: "préparations d'entretien",
  import: "imports de CV"
};

const envInt = (name: string, def: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
};

export function planLimits(plan: PlanId): Record<QuotaKind, number> {
  return plan === "premium"
    ? {
        cv: envInt("QUOTA_PREMIUM_CV", 150),
        letter: envInt("QUOTA_PREMIUM_LETTER", 150),
        rewrite: envInt("QUOTA_PREMIUM_REWRITE", 600),
        interview: envInt("QUOTA_PREMIUM_INTERVIEW", 80),
        import: envInt("QUOTA_PREMIUM_IMPORT", 30)
      }
    : {
        cv: envInt("QUOTA_FREE_CV", 3),
        letter: envInt("QUOTA_FREE_LETTER", 3),
        rewrite: envInt("QUOTA_FREE_REWRITE", 15),
        interview: envInt("QUOTA_FREE_INTERVIEW", 3),
        import: envInt("QUOTA_FREE_IMPORT", 5)
      };
}

export const currentPeriod = (d = new Date()) => d.toISOString().slice(0, 7); // AAAA-MM (UTC)

// ---------------------------------------------------------------------------
// Accès administrateur à Supabase (clé service_role, serveur uniquement)
// ---------------------------------------------------------------------------

export function supabaseAdmin() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) return null;
  return async (p: string, init: RequestInit = {}) => {
    const r = await fetch(`${url}${p}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers as any || {}) },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error(`SUPABASE_${r.status}: ${(await r.text()).slice(0, 200)}`);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  };
}

const planCache = new Map<string, { plan: PlanId; until: number }>();

/** Forfait du compte (abonnement actif et non expiré), en cache 60 s. */
export async function getPlan(uid: string | undefined): Promise<PlanId> {
  if (!uid) return "free";
  const hit = planCache.get(uid);
  if (hit && hit.until > Date.now()) return hit.plan;
  const admin = supabaseAdmin();
  let plan: PlanId = "free";
  if (admin) {
    try {
      const rows = await admin(`/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(uid)}&select=plan,status,current_period_end`);
      const s = rows?.[0];
      const active = s && ["active", "trialing"].includes(s.status) && (!s.current_period_end || new Date(s.current_period_end).getTime() > Date.now());
      if (active && s.plan === "premium") plan = "premium";
    } catch (e: any) {
      logEvent("warn", "plan_lookup_failed", { message: String(e?.message || e).slice(0, 200) });
    }
  }
  planCache.set(uid, { plan, until: Date.now() + 60_000 });
  return plan;
}

export function forgetPlan(uid: string) {
  planCache.delete(uid);
}

/** Usage du mois : comptes → table usage ; visiteurs → stockage clé-valeur par IP. */
export async function getUsage(who: { uid?: string; ip?: string }, period = currentPeriod()): Promise<Record<QuotaKind, number>> {
  const usage: Record<QuotaKind, number> = { cv: 0, letter: 0, rewrite: 0, interview: 0, import: 0 };
  const admin = who.uid ? supabaseAdmin() : null;
  if (who.uid && admin) {
    const rows = await admin(`/rest/v1/usage?user_id=eq.${encodeURIComponent(who.uid)}&period=eq.${period}&select=kind,count`);
    for (const r of rows || []) if (r.kind in usage) usage[r.kind as QuotaKind] = Number(r.count) || 0;
    return usage;
  }
  const id = who.uid ? `uid:${who.uid}` : `ip:${who.ip || "unknown"}`;
  for (const k of Object.keys(usage) as QuotaKind[]) {
    usage[k] = Number(await kv().get(`usage:${period}:${id}:${k}`)) || 0;
  }
  return usage;
}

export async function incrementUsage(who: { uid?: string; ip?: string }, kind: QuotaKind, period = currentPeriod(), amount = 1): Promise<number> {
  const admin = who.uid ? supabaseAdmin() : null;
  if (who.uid && admin) {
    const n = await admin(`/rest/v1/rpc/increment_usage`, { method: "POST", body: JSON.stringify({ p_user: who.uid, p_period: period, p_kind: kind, p_amount: amount }) });
    return Number(n) || 0;
  }
  const id = who.uid ? `uid:${who.uid}` : `ip:${who.ip || "unknown"}`;
  const key = `usage:${period}:${id}:${kind}`;
  return amount >= 0 ? kv().incr(key, 40 * 86400) : kv().decr(key);
}

/**
 * Réserve une unité de quota AVANT le traitement (incrément atomique puis contrôle) :
 * des requêtes simultanées ne peuvent pas dépasser la limite. Renvoie false si la limite est atteinte
 * (la réservation est alors annulée).
 */
export async function reserveUsage(who: { uid?: string; ip?: string }, kind: QuotaKind, limit: number, period = currentPeriod()): Promise<boolean> {
  const count = await incrementUsage(who, kind, period, 1);
  if (count <= limit) return true;
  await releaseUsage(who, kind, period);
  return false;
}

/** Annule une réservation (échec du traitement ou action non facturée). */
export async function releaseUsage(who: { uid?: string; ip?: string }, kind: QuotaKind, period = currentPeriod()): Promise<void> {
  await incrementUsage(who, kind, period, -1);
}

/**
 * Middleware de quota : refuse (402 QUOTA_EXCEEDED) quand le quota du mois est atteint,
 * sinon compte l'action une fois la réponse envoyée avec succès. Renseigne req.plan.
 * QUOTAS=off désactive la vérification (développement, tests).
 */
export function requireQuota(kind: QuotaKind) {
  return async (req: any, res: any, next: any) => {
    const plan = await getPlan(req.uid);
    req.plan = plan;
    if (String(process.env.QUOTAS || "on").toLowerCase() === "off") return next();
    const who = { uid: req.uid, ip: String(req.ip || "") };
    const period = currentPeriod();
    const limit = planLimits(plan)[kind];
    let reserved = false;
    try {
      reserved = await reserveUsage(who, kind, limit, period);
      if (!reserved) {
        logEvent("info", "quota_exceeded", { kind, plan, uid: req.uid ? "account" : "anonymous" });
        return res.status(402).json({
          success: false,
          error: "QUOTA_EXCEEDED",
          kind,
          plan,
          limit,
          message: plan === "premium"
            ? `Limite mensuelle atteinte (${limit} ${QUOTA_LABELS[kind]}). Elle se renouvelle le 1er du mois.`
            : `Vous avez utilisé vos ${limit} ${QUOTA_LABELS[kind]} gratuits de ce mois. Passez à Premium pour continuer.`
        });
      }
    } catch (e: any) {
      // Compteur indisponible : on laisse passer plutôt que de bloquer l'utilisateur
      logEvent("warn", "quota_check_failed", { kind, message: String(e?.message || e).slice(0, 200) });
    }
    // Réservation rendue si l'action échoue ou n'est pas facturée (modèle standard, évaluation locale…)
    res.on("finish", () => {
      if (reserved && (res.statusCode >= 400 || res.locals?.noCharge)) {
        releaseUsage(who, kind, period).catch((e) => logEvent("warn", "usage_release_failed", { kind, message: String(e?.message || e).slice(0, 200) }));
      }
    });
    next();
  };
}
