/**
 * Contrôle avant mise en production (aucune valeur secrète affichée, aucun e-mail ni candidature envoyés).
 *   npm run check:prod
 * 1. Variables : présence et format (clé de chiffrement, VAPID, adresses https…).
 * 2. Base (AUTOMATION_DATABASE_URL) : migrations 001 à 006 appliquées.
 * 3. Supabase : API joignable avec la clé publique.
 * Affiche ensuite les adresses de retour OAuth à déclarer chez Google et Microsoft.
 */
import "dotenv/config";

export interface Finding { level: "ok" | "warn" | "error"; message: string }

const has = (env: Record<string, string | undefined>, k: string) => !!(env[k] || "").trim();

/** Contrôles hors réseau : présence et format des variables. */
export function checkEnv(env: Record<string, string | undefined>): Finding[] {
  const out: Finding[] = [];
  const need = (k: string, why: string) => out.push(has(env, k) ? { level: "ok", message: `${k} définie` } : { level: "error", message: `${k} manquante : ${why}` });
  const want = (k: string, why: string) => { if (!has(env, k)) out.push({ level: "warn", message: `${k} absente : ${why}` }); };

  need("SUPABASE_URL", "comptes et données");
  need("SUPABASE_ANON_KEY", "comptes et données");
  need("SUPABASE_SERVICE_ROLE_KEY", "quotas, suppression de compte");
  need("VITE_SUPABASE_URL", "connexion depuis le navigateur (à définir AVANT le build)");
  need("VITE_SUPABASE_ANON_KEY", "connexion depuis le navigateur (à définir AVANT le build)");
  if (env.AUTH_MODE !== "required") out.push({ level: "error", message: "AUTH_MODE doit valoir « required » en production (API réservée aux comptes)." });
  if (has(env, "AUTOMATION_LOCAL_UID")) out.push({ level: "error", message: "AUTOMATION_LOCAL_UID est réservée aux tests locaux : retirez-la." });
  need("GEMINI_API_KEY", "CV et lettres adaptés par l'IA");

  // Auto-candidature
  need("AUTOMATION_DATABASE_URL", "file de tâches du worker");
  need("AUTOMATION_TOKEN_KEY", "chiffrement des jetons Gmail/Outlook");
  if (has(env, "AUTOMATION_TOKEN_KEY")) {
    const raw = env.AUTOMATION_TOKEN_KEY!.trim();
    if (Buffer.from(raw, "base64").length !== 32 && raw.length < 32) out.push({ level: "error", message: "AUTOMATION_TOKEN_KEY trop faible : utilisez `openssl rand -base64 32`." });
  }
  need("PUBLIC_URL", "adresse de retour OAuth");
  if (has(env, "PUBLIC_URL") && !/^https:\/\/[^/]+$/.test(env.PUBLIC_URL!.trim().replace(/\/$/, ""))) {
    out.push({ level: "error", message: "PUBLIC_URL doit être l'adresse https du site, sans chemin (ex. https://kareer.pro)." });
  }
  const gmail = has(env, "GOOGLE_CLIENT_ID") && has(env, "GOOGLE_CLIENT_SECRET");
  const outlook = has(env, "MICROSOFT_CLIENT_ID") && has(env, "MICROSOFT_CLIENT_SECRET");
  if (!gmail && !outlook) out.push({ level: "error", message: "Aucune messagerie configurée : GOOGLE_CLIENT_ID/SECRET ou MICROSOFT_CLIENT_ID/SECRET." });
  else {
    if (!gmail) out.push({ level: "warn", message: "Gmail non configuré (GOOGLE_CLIENT_ID/SECRET)." });
    if (!outlook) out.push({ level: "warn", message: "Outlook non configuré (MICROSOFT_CLIENT_ID/SECRET)." });
  }
  if (has(env, "VAPID_PUBLIC_KEY") !== has(env, "VAPID_PRIVATE_KEY")) out.push({ level: "error", message: "VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY vont ensemble." });
  else if (!has(env, "VAPID_PUBLIC_KEY")) out.push({ level: "warn", message: "Notifications push désactivées : `npx web-push generate-vapid-keys`." });
  else if (!/^[A-Za-z0-9_-]{80,90}$/.test(env.VAPID_PUBLIC_KEY!.trim())) out.push({ level: "error", message: "VAPID_PUBLIC_KEY au mauvais format (clé base64url générée par web-push)." });
  want("ADMIN_UIDS", "tableau de supervision /api/admin/automation inaccessible");

  // Paiement
  const stripe = ["STRIPE_SECRET_KEY", "STRIPE_PRICE_PREMIUM", "STRIPE_WEBHOOK_SECRET"].filter((k) => has(env, k));
  if (stripe.length && stripe.length < 3) out.push({ level: "error", message: "Stripe incomplet : STRIPE_SECRET_KEY, STRIPE_PRICE_PREMIUM et STRIPE_WEBHOOK_SECRET vont ensemble." });
  if (!stripe.length) out.push({ level: "warn", message: "Stripe non configuré : forfait Premium indisponible." });
  if (has(env, "STRIPE_SECRET_KEY") && /^sk_test_/.test(env.STRIPE_SECRET_KEY!)) out.push({ level: "warn", message: "Stripe en mode test (sk_test_…)." });
  if (stripe.length) want("APP_URL", "retour après paiement");

  // Sources d'offres
  const sources = [["FT_CLIENT_ID", "FT_CLIENT_SECRET"], ["ADZUNA_APP_ID", "ADZUNA_APP_KEY"], ["JSEARCH_API_KEY"], ["JOOBLE_API_KEY"], ["LBA_API_KEY"]]
    .filter((ks) => ks.every((k) => has(env, k))).length;
  out.push(sources ? { level: "ok", message: `${sources} source(s) d'offres configurée(s)` } : { level: "error", message: "Aucune source d'offres configurée (France Travail, Adzuna, JSearch, Jooble, La bonne alternance)." });
  if (!has(env, "UPSTASH_REDIS_REST_URL")) out.push({ level: "warn", message: "Quotas et limites en mémoire : utilisez Upstash Redis si plusieurs instances web tournent." });
  return out;
}

/** Objets créés par chaque migration (contrôle qu'elles ont toutes été appliquées). */
export const MIGRATION_PROBES: { file: string; sql: string }[] = [
  { file: "001_init.sql", sql: "select to_regclass('public.profiles') is not null and to_regclass('public.usage') is not null" },
  { file: "002_automation.sql", sql: "select to_regproc('public.claim_automation_tasks') is not null and to_regclass('public.mail_connections') is not null" },
  { file: "003_push.sql", sql: "select to_regclass('public.push_subscriptions') is not null" },
  { file: "004_sync.sql", sql: "select to_regproc('public.save_profile') is not null and to_regproc('public.patch_application') is not null" },
  { file: "005_billing.sql", sql: "select to_regclass('public.stripe_events') is not null" },
  { file: "006_lba_channel.sql", sql: "select coalesce(bool_or(pg_get_constraintdef(oid) like '%lba%'), false) from pg_constraint where conname = 'application_attempts_channel_check'" }
];

async function checkDatabase(url: string): Promise<Finding[]> {
  const { default: pg } = await import("pg");
  const { needsSsl } = await import("../server/automation/pgStore.ts");
  const client = new pg.Client({ connectionString: url, ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined });
  try {
    await client.connect();
    const out: Finding[] = [];
    for (const m of MIGRATION_PROBES) {
      const row = (await client.query(m.sql)).rows[0];
      const ok = !!row && Object.values(row)[0] === true;
      out.push(ok ? { level: "ok", message: `migration ${m.file} appliquée` } : { level: "error", message: `migration ${m.file} NON appliquée (SQL Editor de Supabase)` });
    }
    return out;
  } catch (e: any) {
    return [{ level: "error", message: `Base injoignable avec AUTOMATION_DATABASE_URL : ${String(e?.message || e).slice(0, 120)}` }];
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkSupabase(url: string, anon: string): Promise<Finding[]> {
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/auth/v1/settings`, { headers: { apikey: anon } });
    if (!r.ok) return [{ level: "error", message: `Supabase répond ${r.status} : vérifiez SUPABASE_URL et SUPABASE_ANON_KEY.` }];
    const s: any = await r.json();
    const out: Finding[] = [{ level: "ok", message: "Supabase joignable" }];
    if (s?.mailer_autoconfirm) out.push({ level: "warn", message: "Confirmation d'adresse e-mail désactivée dans Supabase (Authentication → Providers → Email)." });
    return out;
  } catch (e: any) {
    return [{ level: "error", message: `Supabase injoignable : ${String(e?.message || e).slice(0, 120)}` }];
  }
}

const main = async () => {
  const env = process.env;
  const findings = checkEnv(env);
  if (has(env, "AUTOMATION_DATABASE_URL")) findings.push(...await checkDatabase(env.AUTOMATION_DATABASE_URL!));
  if (has(env, "SUPABASE_URL") && has(env, "SUPABASE_ANON_KEY")) findings.push(...await checkSupabase(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!));
  const icon = { ok: "✓", warn: "!", error: "✗" };
  for (const f of findings) console.log(`  ${icon[f.level]} ${f.message}`);
  if (has(env, "PUBLIC_URL")) {
    const base = env.PUBLIC_URL!.trim().replace(/\/$/, "");
    console.log(`\nAdresses de retour OAuth à déclarer :\n  Google    ${base}/api/automation/oauth/gmail/callback\n  Microsoft ${base}/api/automation/oauth/outlook/callback`);
  }
  const errors = findings.filter((f) => f.level === "error").length;
  console.log(errors ? `\n${errors} point(s) bloquant(s) avant la mise en production.` : "\nPrêt pour un premier essai réel (1 candidature/jour vers une adresse que vous contrôlez).");
  process.exit(errors ? 1 : 0);
};

if (process.argv[1] && /preflight\.ts$/.test(process.argv[1])) await main();
