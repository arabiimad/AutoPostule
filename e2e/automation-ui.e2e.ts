/**
 * Candidature automatique dans le navigateur, de bout en bout :
 * serveur web + worker réels (build/server), PostgreSQL réel, sources, IA, OAuth Google et Gmail simulés.
 *
 *   npm run build
 *   AUTOMATION_PG="-h /var/tmp/kareer-pg -p 5433 -U postgres" npm run test:e2e:automation
 *
 * Parcours : connexion Gmail (OAuth) → réglages → activation avec consentement → le worker cherche, prépare et
 * envoie → l'écran affiche l'envoi, le tableau Candidatures l'indique → pause.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { startMockSources, mailbox } from "./mock-sources.mjs";
import { e2eServerEnv, MOCK_PORT } from "./env.mjs";

const ARGS = (process.env.AUTOMATION_PG || "").split(/\s+/).filter(Boolean);
if (!ARGS.length) {
  console.error("AUTOMATION_PG manquant (arguments psql d'un PostgreSQL local).");
  process.exit(1);
}
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
for (const f of ["build/server/server.cjs", "build/server/worker.cjs", "dist/index.html"]) {
  if (!fs.existsSync(path.join(root, f))) {
    console.error(`${f} introuvable : lancez d'abord « npm run build ».`);
    process.exit(1);
  }
}
const { chromium } = await import("playwright");
const arg = (f: string) => { const i = ARGS.indexOf(f); return i >= 0 ? ARGS[i + 1] : undefined; };
const DB = `kareer_e2e_ui_${process.pid}`;
const U = "00000000-0000-0000-0000-00000000aa01";
const APP_PORT = 3127;
const BASE = `http://localhost:${APP_PORT}`;

const results: { label: string; ok: boolean }[] = [];
const check = (label: string, cond: unknown, detail = "") => {
  results.push({ label, ok: !!cond });
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}${!cond && detail ? ` — ${detail}` : ""}`);
};

execFileSync("psql", [...ARGS, "-d", "postgres", "-qc", `drop database if exists ${DB}`, "-c", `create database ${DB}`]);
for (const f of ["tests/sql/supabase-shim.sql", "supabase/migrations/001_init.sql", "supabase/migrations/002_automation.sql", "supabase/migrations/003_push.sql"]) {
  execFileSync("psql", [...ARGS, "-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "-f", path.join(root, f)], { stdio: ["ignore", "ignore", "pipe"] });
}
const host = arg("-h") || "localhost";
const port = arg("-p") || "5432";
const user = arg("-U") || "postgres";
const dbUrl = host.startsWith("/")
  ? `postgresql://${user}@/${DB}?host=${encodeURIComponent(host)}&port=${port}`
  : `postgresql://${user}${process.env.PGPASSWORD ? `:${process.env.PGPASSWORD}` : ""}@${host}:${port}/${DB}?sslmode=disable`;
const pool = new pg.Pool({ connectionString: dbUrl });
const q = async (t: string, v: unknown[] = []) => (await pool.query(t, v)).rows;

const profile = {
  fullName: "Karim Dupont", title: "Développeur Python", email: "karim@gmail.com", location: "Avignon",
  skills: ["Python", "Django", "Docker", "React", "TypeScript", "Node.js", "Git"],
  experiences: [{ id: "e1", title: "Développeur Python", company: "Studio X", startDate: "2021", current: true, bullets: ["Développement de services Python et Django", "Conteneurisation avec Docker"] }],
  education: [], languages: ["Français"]
};
await q("insert into auth.users (id, email) values ($1, 'karim@gmail.com')", [U]);
// Profil du compte (en production : enregistré par l'application dans Supabase)
await q("insert into public.profiles (id, data) values ($1, $2)", [U, profile]);

const mock = await startMockSources(MOCK_PORT);
const m = `http://localhost:${MOCK_PORT}`;
const env = {
  ...e2eServerEnv(),
  NODE_ENV: "production",
  PORT: String(APP_PORT),
  AUTH_MODE: "off",
  AUTOMATION_LOCAL_UID: U,
  AUTOMATION_DATABASE_URL: dbUrl,
  AUTOMATION_TOKEN_KEY: "cle-e2e-interface",
  AUTOMATION_POLL_SECONDS: "5",
  PUBLIC_URL: BASE,
  GOOGLE_CLIENT_ID: "gid-e2e", GOOGLE_CLIENT_SECRET: "gsecret-e2e",
  GOOGLE_AUTH_URL: `${m}/oauth/authorize`, GOOGLE_TOKEN_URL: `${m}/oauth/token`,
  GMAIL_API_URL: `${m}/gmail/send`
};
let log = "";
const start = (file: string): ChildProcess => {
  const p = spawn(process.execPath, [file], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout!.on("data", (d) => (log += d));
  p.stderr!.on("data", (d) => (log += d));
  return p;
};
const server = start("build/server/server.cjs");
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* démarrage */ }
  await new Promise((r) => setTimeout(r, 250));
}
let worker: ChildProcess | null = null;
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });

try {
  console.log("\nCandidature automatique (interface + worker)");
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, locale: "fr-FR" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?onglet=assistant`, { waitUntil: "domcontentloaded" });
  const panel = page.locator("section", { has: page.getByRole("heading", { name: "Candidature automatique" }) });
  await panel.getByText("Désactivée").waitFor({ timeout: 15000 });
  check("panneau affiché, automatisation désactivée par défaut", await panel.getByText("Désactivée").isVisible());

  // Connexion Gmail (OAuth simulé) puis retour dans l'application
  await panel.getByRole("button", { name: "Connecter Gmail" }).click();
  await page.waitForURL(/onglet=assistant/, { timeout: 15000 });
  await panel.getByText(/Gmail : karim@gmail\.com/).waitFor({ timeout: 15000 });
  check("Gmail connecté (retour OAuth), adresse affichée", await panel.getByText(/Gmail : karim@gmail\.com/).isVisible());
  check("message de confirmation après la connexion", await page.getByText("Messagerie connectée").isVisible().catch(() => false));
  check("paramètre de retour retiré de l'adresse", !/messagerie=/.test(page.url()));
  const [conn] = await q("select access_token_enc from public.mail_connections where user_id = $1", [U]);
  check("jeton stocké chiffré", !!conn && !/jeton-acces/.test(conn.access_token_enc));

  // Réglages puis activation avec consentement
  await panel.getByLabel("Métiers recherchés").fill("développeur");
  await panel.getByLabel("Lieux").fill("Avignon");
  await panel.getByLabel(/Compatibilité minimale/).fill("30");
  await panel.getByRole("button", { name: "Activer la candidature automatique" }).click();
  const confirm = panel.getByRole("button", { name: "Confirmer l’activation" });
  check("activation impossible sans consentement coché", await confirm.isDisabled());
  await panel.getByLabel(/J’autorise l’envoi automatique/).check();
  await confirm.click();
  await panel.getByText("Active", { exact: true }).waitFor({ timeout: 15000 });
  const [pol] = await q("select enabled, consented_at, roles, min_fit from public.automation_policies where user_id = $1", [U]);
  check("automatisation active, consentement horodaté", pol?.enabled && !!pol?.consented_at && pol.roles[0] === "développeur" && pol.min_fit === 30, JSON.stringify(pol));

  // Le worker travaille en arrière-plan (navigateur inutile)
  worker = start("build/server/worker.cjs");
  const end = Date.now() + 120_000;
  while (Date.now() < end && mailbox.length === 0) await new Promise((r) => setTimeout(r, 1000));
  await new Promise((r) => setTimeout(r, 3000));
  check("candidature envoyée par le worker depuis Gmail", mailbox.length === 1 && /^To: recrutement@datasud\.fr$/m.test(mailbox[0]?.raw || ""), `${mailbox.length} message(s)`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await panel.getByText("Envoyées aujourd’hui").waitFor({ timeout: 15000 });
  const text = await panel.textContent();
  check("écran : envoi du jour compté", /Envoyées aujourd’hui\s*1\/5/.test(text || ""), (text || "").slice(0, 200));
  check("écran : activité avec l'envoi et les offres à valider", /Candidature envoyée à DataSud/.test(text || "") && /à valider sur|non pris en charge/.test(text || ""), (text || "").slice(-400));

  // Pause
  await panel.getByRole("button", { name: "Mettre en pause" }).click();
  await panel.getByText("En pause", { exact: true }).waitFor({ timeout: 10000 });
  check("pause visible et enregistrée", (await q("select paused from public.automation_policies where user_id = $1", [U]))[0].paused === true);
  check("aucune erreur JavaScript", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.screenshot({ path: path.join(root, "test-results", "candidature-automatique.png"), fullPage: true }).catch(() => null);
  await ctx.close();
} catch (e: any) {
  check("exécution sans exception", false, `${e?.message}\n${log.slice(-800)}`);
} finally {
  await browser.close();
  for (const p of [server, worker]) p?.kill("SIGTERM");
  mock.close();
  await pool.end();
  try { execFileSync("psql", [...ARGS, "-d", "postgres", "-qc", `drop database if exists ${DB} with (force)`]); } catch { /* conservée pour diagnostic */ }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} vérifications réussies.`);
process.exit(failed ? 1 : 0);
