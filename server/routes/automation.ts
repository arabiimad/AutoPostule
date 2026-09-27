/**
 * API de l'auto-candidature (compte obligatoire) :
 *   GET    /api/automation                     état : politique, messageries connectées, activité, envois du jour
 *   PUT    /api/automation/policy              réglages ; activation = consentement explicite obligatoire
 *   POST   /api/automation/pause | /resume     pause immédiate (vérifiée avant chaque envoi) / reprise
 *   POST   /api/automation/connect/:provider   adresse d'autorisation OAuth (Gmail, Outlook)
 *   GET    /api/automation/oauth/:provider/callback   retour OAuth (état signé : aucun jeton de session dans l'URL)
 *   DELETE /api/automation/connections/:provider      déconnexion (jetons supprimés, autorisation révoquée)
 *
 * Indisponible (501) si AUTOMATION_DATABASE_URL ou AUTOMATION_TOKEN_KEY ne sont pas configurés.
 */
import type { Express } from "express";
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import pg from "pg";
import { authMiddleware } from "../auth.ts";
import { createRateLimiter } from "../rateLimit.ts";
import { PgAutomationStore } from "../automation/pgStore.ts";
import { policyFromRow } from "../automation/policy.ts";
import { encryptToken, decryptToken, GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL } from "../automation/email.ts";
import { logEvent } from "../log.ts";

type Provider = "gmail" | "outlook";
const PROVIDERS: Provider[] = ["gmail", "outlook"];
const CONTRACTS = ["cdi", "cdd", "alternance", "stage", "freelance"];
const REMOTE = ["total", "hybride", "sur-site"];
const CHANNELS = ["email", "form"];

const GOOGLE_AUTH_URL = process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_REVOKE_URL = process.env.GOOGLE_REVOKE_URL || "https://oauth2.googleapis.com/revoke";
const MICROSOFT_AUTH_URL = process.env.MICROSOFT_AUTH_URL || "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const SCOPES: Record<Provider, string> = {
  gmail: "openid email https://www.googleapis.com/auth/gmail.send",
  outlook: "openid email offline_access https://graph.microsoft.com/Mail.Send"
};

let pool: pg.Pool | null | undefined;
function db(): pg.Pool | null {
  if (pool === undefined) pool = PgAutomationStore.fromEnv()?.pool ?? null;
  return pool;
}
/** Pour les tests : base injectée. */
export function setAutomationPool(p: pg.Pool | null) {
  pool = p;
}

const maxDaily = () => Math.max(1, Math.min(20, Number(process.env.AUTOMATION_MAX_DAILY) || 5));
const publicUrl = () => (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const redirectUri = (p: Provider) => `${publicUrl()}/api/automation/oauth/${p}/callback`;

// ---------------------------------------------------------------------------
// État OAuth signé (identifie le compte au retour de Google / Microsoft, expire en 10 min)
// ---------------------------------------------------------------------------
const stateKey = () => createHash("sha256").update(`oauth-state:${process.env.AUTOMATION_TOKEN_KEY || ""}`).digest();
export function signState(uid: string, provider: Provider, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ uid, provider, exp: now + 10 * 60_000, n: randomBytes(8).toString("hex") })).toString("base64url");
  return `${body}.${createHmac("sha256", stateKey()).update(body).digest("base64url")}`;
}
export function verifyState(state: string, provider: Provider, now = Date.now()): string | null {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", stateKey()).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString());
    return s.provider === provider && s.exp > now && typeof s.uid === "string" ? s.uid : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation des réglages
// ---------------------------------------------------------------------------
const list = (v: unknown, max: number, len = 80) =>
  Array.from(new Set((Array.isArray(v) ? v : []).map((x) => String(x ?? "").trim().slice(0, len)).filter(Boolean))).slice(0, max);

export function sanitizePolicy(body: any) {
  const errors: string[] = [];
  const contracts = list(body?.contracts, 5).filter((c) => CONTRACTS.includes(c));
  const remote = list(body?.remote, 3).filter((r) => REMOTE.includes(r));
  const channels = list(body?.channels, 2).filter((c) => CHANNELS.includes(c));
  const roles = list(body?.roles, 5);
  const minFit = Math.round(Number(body?.minFit ?? 60));
  const dailyLimit = Math.round(Number(body?.dailyLimit ?? 5));
  const minSalary = body?.minSalary == null || body?.minSalary === "" ? null : Math.round(Number(body.minSalary));
  if (!Number.isFinite(minFit) || minFit < 0 || minFit > 100) errors.push("Compatibilité minimale entre 0 et 100 %.");
  if (!Number.isFinite(dailyLimit) || dailyLimit < 1 || dailyLimit > maxDaily()) errors.push(`Entre 1 et ${maxDaily()} candidatures par jour.`);
  if (minSalary !== null && (!Number.isFinite(minSalary) || minSalary < 0 || minSalary > 500_000)) errors.push("Salaire minimal invalide.");
  if (body?.enabled && !roles.length) errors.push("Indiquez au moins un métier recherché.");
  if (body?.enabled && !channels.length) errors.push("Choisissez au moins un canal d'envoi.");
  return {
    errors,
    policy: {
      enabled: !!body?.enabled,
      roles, contracts, remote, channels,
      locations: list(body?.locations, 5),
      excludedCompanies: list(body?.excludedCompanies, 30),
      excludedKeywords: list(body?.excludedKeywords, 30),
      minFit, dailyLimit, minSalary
    }
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function registerAutomationRoutes(app: Express, opts: { auth?: any } = {}) {
  const auth = opts.auth ?? authMiddleware({ optional: true });
  const limiter = createRateLimiter("automation", 60, 60_000);

  // Service configuré ? Compte connecté ?
  const guard = (req: any, res: any, next: any) => {
    if (!db() || !process.env.AUTOMATION_TOKEN_KEY) {
      return res.status(501).json({ success: false, error: "AUTOMATION_UNAVAILABLE", message: "La candidature automatique n'est pas encore disponible sur ce serveur." });
    }
    if (!req.uid) return res.status(401).json({ success: false, error: "Connexion requise : la candidature automatique nécessite un compte." });
    next();
  };
  const q = async (text: string, values: unknown[] = []) => (await db()!.query(text, values)).rows;

  app.get("/api/automation", auth, limiter, guard, async (req: any, res) => {
    const uid = req.uid;
    const [policyRow] = await q(`select * from public.automation_policies where user_id = $1`, [uid]);
    const connections = await q(`select provider, email, status, updated_at from public.mail_connections where user_id = $1 order by provider`, [uid]);
    const [today] = await q(
      `select count(*) filter (where status in ('submitted', 'confirmed'))::int as sent,
              count(*) filter (where status = 'uncertain')::int as uncertain
         from public.application_attempts
        where user_id = $1 and created_at >= date_trunc('day', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris'`,
      [uid]
    );
    const [tasks] = await q(
      `select count(*) filter (where status in ('queued', 'running'))::int as pending,
              count(*) filter (where status = 'needs_user')::int as needs_user
         from public.automation_tasks where user_id = $1 and created_at > now() - interval '30 days'`,
      [uid]
    );
    const events = await q(
      `select type, message, created_at from public.automation_events where user_id = $1 order by created_at desc limit 50`,
      [uid]
    );
    const policy = policyRow ? { ...policyFromRow(policyRow), consentedAt: policyRow.consented_at } : null;
    return res.json({
      available: true,
      maxDaily: maxDaily(),
      oauth: { gmail: !!process.env.GOOGLE_CLIENT_ID, outlook: !!process.env.MICROSOFT_CLIENT_ID },
      policy,
      connections: connections.map((c) => ({ provider: c.provider, email: c.email, status: c.status })),
      today: { sent: today?.sent || 0, uncertain: today?.uncertain || 0, limit: policy?.dailyLimit ?? null },
      pending: tasks?.pending || 0,
      needsUser: tasks?.needs_user || 0,
      events: events.map((e) => ({ type: e.type, message: e.message, at: e.created_at }))
    });
  });

  app.put("/api/automation/policy", auth, limiter, guard, async (req: any, res) => {
    const { errors, policy } = sanitizePolicy(req.body);
    if (policy.enabled && req.body?.consent !== true) errors.push("Confirmez que vous autorisez l'envoi automatique de candidatures en votre nom.");
    if (errors.length) return res.status(400).json({ success: false, error: errors.join(" ") });
    const [row] = await q(
      `insert into public.automation_policies (user_id, enabled, roles, contracts, locations, remote, min_salary, min_fit, excluded_companies, excluded_keywords, channels, daily_limit, consented_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, case when $2 then now() end)
       on conflict (user_id) do update set enabled = excluded.enabled, roles = excluded.roles, contracts = excluded.contracts,
         locations = excluded.locations, remote = excluded.remote, min_salary = excluded.min_salary, min_fit = excluded.min_fit,
         excluded_companies = excluded.excluded_companies, excluded_keywords = excluded.excluded_keywords, channels = excluded.channels,
         daily_limit = excluded.daily_limit,
         consented_at = case when excluded.enabled then coalesce(public.automation_policies.consented_at, now()) else public.automation_policies.consented_at end
       returning *`,
      [req.uid, policy.enabled, policy.roles, policy.contracts, policy.locations, policy.remote, policy.minSalary, policy.minFit,
       policy.excludedCompanies, policy.excludedKeywords, policy.channels, policy.dailyLimit]
    );
    if (policy.enabled) {
      // Première recherche sans attendre la planification
      await q(
        `insert into public.automation_tasks (user_id, kind) select $1, 'search'
          where not exists (select 1 from public.automation_tasks where user_id = $1 and kind = 'search' and status in ('queued', 'running'))`,
        [req.uid]
      );
    }
    await q(`insert into public.automation_events (user_id, type, message) values ($1, 'policy', $2)`,
      [req.uid, policy.enabled ? "Candidature automatique activée." : "Réglages enregistrés (candidature automatique désactivée)."]);
    logEvent("info", "automation_policy_saved", { enabled: policy.enabled, channels: policy.channels });
    return res.json({ success: true, policy: { ...policyFromRow(row), consentedAt: row.consented_at } });
  });

  for (const action of ["pause", "resume"] as const) {
    app.post(`/api/automation/${action}`, auth, limiter, guard, async (req: any, res) => {
      const rows = await q(`update public.automation_policies set paused = $2 where user_id = $1 returning paused`, [req.uid, action === "pause"]);
      if (!rows.length) return res.status(404).json({ success: false, error: "Aucun réglage d'automatisation." });
      await q(`insert into public.automation_events (user_id, type, message) values ($1, $2, $3)`,
        [req.uid, action, action === "pause" ? "Candidature automatique mise en pause : aucun nouvel envoi." : "Candidature automatique reprise."]);
      return res.json({ success: true, paused: rows[0].paused });
    });
  }

  app.post("/api/automation/connect/:provider", auth, limiter, guard, (req: any, res) => {
    const provider = req.params.provider as Provider;
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ success: false, error: "Messagerie inconnue." });
    const clientId = provider === "gmail" ? process.env.GOOGLE_CLIENT_ID : process.env.MICROSOFT_CLIENT_ID;
    if (!clientId || !publicUrl()) return res.status(501).json({ success: false, error: "Connexion de cette messagerie non configurée sur le serveur." });
    const params = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri(provider), response_type: "code", scope: SCOPES[provider],
      state: signState(req.uid, provider), prompt: provider === "gmail" ? "consent" : "select_account",
      ...(provider === "gmail" ? { access_type: "offline", include_granted_scopes: "true" } : {})
    });
    return res.json({ url: `${provider === "gmail" ? GOOGLE_AUTH_URL : MICROSOFT_AUTH_URL}?${params}` });
  });

  app.get("/api/automation/oauth/:provider/callback", limiter, async (req: any, res) => {
    const provider = req.params.provider as Provider;
    const back = (status: string) => res.redirect(302, `/?onglet=assistant&messagerie=${status}`);
    if (!PROVIDERS.includes(provider) || !db() || !process.env.AUTOMATION_TOKEN_KEY) return back("indisponible");
    const uid = verifyState(String(req.query.state || ""), provider);
    if (!uid) return back("refusee");
    if (req.query.error || !req.query.code) return back("annulee");
    const google = provider === "gmail";
    try {
      const r = await fetch(google ? GOOGLE_TOKEN_URL : MICROSOFT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: String(google ? process.env.GOOGLE_CLIENT_ID : process.env.MICROSOFT_CLIENT_ID),
          client_secret: String(google ? process.env.GOOGLE_CLIENT_SECRET : process.env.MICROSOFT_CLIENT_SECRET),
          grant_type: "authorization_code", code: String(req.query.code), redirect_uri: redirectUri(provider)
        }).toString(),
        signal: AbortSignal.timeout(15_000)
      });
      const data: any = await r.json().catch(() => ({}));
      if (!r.ok || !data.access_token || !data.refresh_token) {
        logEvent("warn", "automation_oauth_failed", { provider, status: r.status });
        return back("erreur");
      }
      // Adresse du compte : jeton d'identité reçu directement du fournisseur (connexion TLS)
      const claims = JSON.parse(Buffer.from(String(data.id_token || "").split(".")[1] || "", "base64url").toString() || "{}");
      const email = String(claims.email || claims.preferred_username || "").toLowerCase();
      if (!email.includes("@")) return back("erreur");
      const granted = String(data.scope || SCOPES[provider]).split(/\s+/);
      const canSend = granted.some((s) => /gmail\.send|Mail\.Send/i.test(s));
      if (!canSend) return back("permission");
      await q(
        `insert into public.mail_connections (user_id, provider, email, status, scopes, access_token_enc, refresh_token_enc, expires_at)
         values ($1, $2, $3, 'active', $4, $5, $6, now() + make_interval(secs => $7))
         on conflict (user_id, provider) do update set email = excluded.email, status = 'active', scopes = excluded.scopes,
           access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc, expires_at = excluded.expires_at`,
        [uid, provider, email, granted, encryptToken(data.access_token), encryptToken(data.refresh_token), Number(data.expires_in) || 3600]
      );
      await q(`insert into public.automation_events (user_id, type, message) values ($1, 'connection', $2)`,
        [uid, `Messagerie ${google ? "Gmail" : "Outlook"} connectée (${email}).`]);
      return back("connectee");
    } catch (e: any) {
      logEvent("warn", "automation_oauth_failed", { provider, message: String(e?.message || e).slice(0, 200) });
      return back("erreur");
    }
  });

  app.delete("/api/automation/connections/:provider", auth, limiter, guard, async (req: any, res) => {
    const provider = req.params.provider as Provider;
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ success: false, error: "Messagerie inconnue." });
    const [c] = await q(`delete from public.mail_connections where user_id = $1 and provider = $2 returning refresh_token_enc`, [req.uid, provider]);
    if (c?.refresh_token_enc && provider === "gmail") {
      // Révocation côté Google (Microsoft : l'utilisateur retire l'accès dans son compte)
      try {
        await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(decryptToken(c.refresh_token_enc))}`, { method: "POST", signal: AbortSignal.timeout(8000) });
      } catch { /* jetons supprimés de toute façon */ }
    }
    await q(`insert into public.automation_events (user_id, type, message) values ($1, 'connection', $2)`,
      [req.uid, `Messagerie ${provider === "gmail" ? "Gmail" : "Outlook"} déconnectée.`]);
    return res.json({ success: true });
  });
}
