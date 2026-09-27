/**
 * Stripe (paiement de l'abonnement Premium) sans SDK : API REST + vérification des webhooks.
 *
 * Variables : STRIPE_SECRET_KEY (sk_test_… / sk_live_…), STRIPE_PRICE_PREMIUM (price_…),
 * STRIPE_WEBHOOK_SECRET (whsec_…), APP_URL (adresse publique, pour les retours de paiement).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const stripeEnabled = () => !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_PREMIUM);

/** Encode un objet imbriqué au format attendu par Stripe (a[b][0]=c). */
export function formEncode(obj: Record<string, any>, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") parts.push(formEncode(v, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.filter(Boolean).join("&");
}

export async function stripeApi(
  path: string,
  params?: Record<string, any>,
  method: "GET" | "POST" | "DELETE" = params ? "POST" : "GET",
  opts: { idempotencyKey?: string } = {}
) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_NOT_CONFIGURED");
  const base = (process.env.STRIPE_API_URL || "https://api.stripe.com").replace(/\/$/, "");
  const r = await fetch(`${base}/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": "2024-06-20",
      // Même clé = même résultat : un double clic ne crée pas deux sessions de paiement
      ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {})
    },
    body: params && method !== "GET" ? formEncode(params) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`STRIPE_${r.status}: ${data?.error?.message || "erreur"}`);
  return data;
}

/**
 * Vérifie l'en-tête Stripe-Signature (t=…,v1=…) : HMAC-SHA256 de « t.payload » avec le secret du webhook.
 * Tolérance de 5 minutes contre le rejeu.
 */
export function verifyStripeSignature(payload: Buffer | string, header: string, secret: string, toleranceSec = 300, now = Date.now()): boolean {
  if (!header || !secret) return false;
  const items = header.split(",").map((p) => p.split("="));
  const t = items.find(([k]) => k === "t")?.[1];
  const sigs = items.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length) return false;
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${typeof payload === "string" ? payload : payload.toString("utf8")}`).digest("hex");
  return sigs.some((s) => {
    try {
      return s.length === expected.length && timingSafeEqual(Buffer.from(s, "hex"), Buffer.from(expected, "hex"));
    } catch {
      return false;
    }
  });
}
