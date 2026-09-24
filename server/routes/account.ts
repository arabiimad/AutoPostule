import express, { type Express } from "express";
import { logEvent } from "../log.ts";
import { currentPeriod, forgetPlan, getPlan, getUsage, planLimits, supabaseAdmin, type PlanId } from "../plans.ts";
import { stripeApi, stripeEnabled, verifyStripeSignature } from "../stripe.ts";

const appUrl = (req: any) => (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const needAccount = (req: any, res: any) => {
  if (req.uid) return false;
  res.status(401).json({ success: false, error: "Connectez-vous à votre compte pour cette action." });
  return true;
};

async function subscriptionRow(uid: string) {
  const admin = supabaseAdmin();
  if (!admin) return null;
  const rows = await admin(`/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(uid)}&select=*`);
  return rows?.[0] || null;
}

async function upsertSubscription(row: Record<string, any>) {
  const admin = supabaseAdmin();
  if (!admin) throw new Error("SUPABASE_NOT_CONFIGURED");
  await admin(`/rest/v1/subscriptions?on_conflict=user_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ ...row, updated_at: new Date().toISOString() })
  });
  if (row.user_id) forgetPlan(row.user_id);
}

/** Abonnement Stripe → ligne `subscriptions` (le compte est retrouvé via les métadonnées). */
async function syncSubscription(sub: any, fallbackUid?: string) {
  const uid = sub?.metadata?.uid || fallbackUid;
  if (!uid) return logEvent("warn", "stripe_subscription_without_uid", { id: sub?.id });
  const plan: PlanId = ["active", "trialing", "past_due"].includes(sub.status) ? "premium" : "free";
  await upsertSubscription({
    user_id: uid,
    plan,
    status: sub.status,
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
    stripe_subscription_id: sub.id,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
  });
  logEvent("info", "subscription_synced", { plan, status: sub.status });
}

export function registerAccountRoutes(app: Express) {
  // Webhook Stripe : corps brut indispensable pour vérifier la signature (enregistré avant express.json)
  app.post("/api/billing/webhook", express.raw({ type: "application/json", limit: "1mb" }), async (req: any, res) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
    if (!verifyStripeSignature(req.body, String(req.headers["stripe-signature"] || ""), secret)) {
      return res.status(400).json({ error: "Signature invalide" });
    }
    let event: any;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "JSON invalide" });
    }
    try {
      const obj = event.data?.object;
      if (event.type === "checkout.session.completed" && obj?.mode === "subscription" && obj.subscription) {
        const sub = await stripeApi(`/subscriptions/${obj.subscription}`);
        await syncSubscription(sub, obj.client_reference_id || obj.metadata?.uid);
      } else if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
        await syncSubscription(obj);
      }
      return res.json({ received: true });
    } catch (e: any) {
      logEvent("error", "stripe_webhook_failed", { type: event?.type, message: String(e?.message || e).slice(0, 300) });
      return res.status(500).json({ error: "Traitement impossible" }); // Stripe réessaiera
    }
  });
}

export function registerAccountApiRoutes(app: Express) {
  // Forfait, quotas et consommation du mois (visiteurs : compteur par adresse IP)
  app.get("/api/account/usage", async (req: any, res) => {
    const plan = await getPlan(req.uid);
    let usage: Record<string, number> = {};
    try {
      usage = await getUsage({ uid: req.uid, ip: String(req.ip || "") });
    } catch { /* compteur indisponible */ }
    const sub = req.uid ? await subscriptionRow(req.uid).catch(() => null) : null;
    res.json({
      plan,
      period: currentPeriod(),
      limits: planLimits(plan),
      usage,
      quotasEnabled: String(process.env.QUOTAS || "on").toLowerCase() !== "off",
      billing: { enabled: stripeEnabled(), status: sub?.status || null, renewsAt: sub?.current_period_end || null, hasCustomer: !!sub?.stripe_customer_id },
      account: !!req.uid
    });
  });

  // Paiement : session Stripe Checkout (abonnement Premium)
  app.post("/api/billing/checkout", async (req: any, res) => {
    if (needAccount(req, res)) return;
    if (!stripeEnabled()) return res.status(501).json({ success: false, error: "Le paiement n'est pas encore activé." });
    try {
      const sub = await subscriptionRow(req.uid).catch(() => null);
      const base = appUrl(req);
      const session = await stripeApi("/checkout/sessions", {
        mode: "subscription",
        line_items: [{ price: process.env.STRIPE_PRICE_PREMIUM, quantity: 1 }],
        client_reference_id: req.uid,
        ...(sub?.stripe_customer_id ? { customer: sub.stripe_customer_id } : { customer_email: req.email }),
        subscription_data: { metadata: { uid: req.uid } },
        metadata: { uid: req.uid },
        allow_promotion_codes: "true",
        locale: "fr",
        success_url: `${base}/?onglet=tarifs&paiement=ok`,
        cancel_url: `${base}/?onglet=tarifs&paiement=annule`
      });
      return res.json({ success: true, url: session.url });
    } catch (e: any) {
      logEvent("error", "checkout_failed", { message: String(e?.message || e).slice(0, 300) });
      return res.status(502).json({ success: false, error: "Le paiement est momentanément indisponible. Réessayez." });
    }
  });

  // Gestion de l'abonnement (carte, factures, résiliation) : portail client Stripe
  app.post("/api/billing/portal", async (req: any, res) => {
    if (needAccount(req, res)) return;
    try {
      const sub = await subscriptionRow(req.uid);
      if (!sub?.stripe_customer_id) return res.status(404).json({ success: false, error: "Aucun abonnement associé à ce compte." });
      const portal = await stripeApi("/billing_portal/sessions", { customer: sub.stripe_customer_id, return_url: `${appUrl(req)}/?onglet=tarifs` });
      return res.json({ success: true, url: portal.url });
    } catch (e: any) {
      logEvent("error", "portal_failed", { message: String(e?.message || e).slice(0, 300) });
      return res.status(502).json({ success: false, error: "Le portail d'abonnement est momentanément indisponible." });
    }
  });

  // RGPD : export de toutes les données du compte
  app.get("/api/account/export", async (req: any, res) => {
    if (needAccount(req, res)) return;
    const admin = supabaseAdmin();
    if (!admin) return res.status(501).json({ success: false, error: "Comptes en ligne non configurés." });
    try {
      const id = encodeURIComponent(req.uid);
      const [profile, applications, usage, subscription] = await Promise.all([
        admin(`/rest/v1/profiles?id=eq.${id}&select=data,created_at,updated_at`),
        admin(`/rest/v1/applications?user_id=eq.${id}&select=data,created_at,updated_at`),
        admin(`/rest/v1/usage?user_id=eq.${id}&select=period,kind,count`),
        admin(`/rest/v1/subscriptions?user_id=eq.${id}&select=plan,status,current_period_end`)
      ]);
      res.setHeader("Content-Disposition", `attachment; filename="autopostule-export-${new Date().toISOString().slice(0, 10)}.json"`);
      return res.json({
        exportedAt: new Date().toISOString(),
        account: { id: req.uid, email: req.email },
        profile: profile?.[0]?.data || null,
        applications: (applications || []).map((a: any) => a.data),
        usage,
        subscription: subscription?.[0] || null
      });
    } catch (e: any) {
      logEvent("error", "export_failed", { message: String(e?.message || e).slice(0, 300) });
      return res.status(502).json({ success: false, error: "Export impossible pour le moment. Réessayez." });
    }
  });

  // RGPD : suppression définitive du compte (abonnement résilié, puis toutes les données effacées en cascade)
  app.delete("/api/account", async (req: any, res) => {
    if (needAccount(req, res)) return;
    const admin = supabaseAdmin();
    if (!admin) return res.status(501).json({ success: false, error: "Comptes en ligne non configurés." });
    try {
      const sub = await subscriptionRow(req.uid).catch(() => null);
      if (sub?.stripe_subscription_id && ["active", "trialing", "past_due"].includes(sub.status) && process.env.STRIPE_SECRET_KEY) {
        await stripeApi(`/subscriptions/${sub.stripe_subscription_id}`, undefined, "DELETE");
      }
      await admin(`/auth/v1/admin/users/${encodeURIComponent(req.uid)}`, { method: "DELETE" });
      forgetPlan(req.uid);
      logEvent("info", "account_deleted", {});
      return res.json({ success: true });
    } catch (e: any) {
      logEvent("error", "account_delete_failed", { message: String(e?.message || e).slice(0, 300) });
      return res.status(502).json({ success: false, error: "Suppression impossible pour le moment. Réessayez ou contactez le support." });
    }
  });
}
