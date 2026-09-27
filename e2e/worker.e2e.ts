/**
 * Auto-candidature de bout en bout, avec le VRAI processus worker (build/server/worker.cjs) :
 * PostgreSQL réel, sources d'offres et IA simulées, fausse API Gmail.
 *
 *   npm run build
 *   AUTOMATION_PG="-h /var/tmp/kareer-pg -p 5433 -U postgres" npm run test:e2e:worker
 *
 * Vérifie : recherche planifiée → offre qualifiée → CV (PDF) + lettre → email envoyé depuis la boîte du candidat ;
 * offres sur plateformes → action demandée ; redémarrage du worker → aucun doublon ; pause → plus aucun envoi.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { startMockSources, mailbox } from "./mock-sources.mjs";
import { e2eServerEnv, MOCK_PORT } from "./env.mjs";

process.env.AUTOMATION_TOKEN_KEY = "cle-e2e-pour-les-jetons-de-messagerie";
const { encryptToken } = await import("../server/automation/email.ts");

const ARGS = (process.env.AUTOMATION_PG || "").split(/\s+/).filter(Boolean);
if (!ARGS.length) {
  console.error("AUTOMATION_PG manquant (arguments psql d'un PostgreSQL local).");
  process.exit(1);
}
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
if (!fs.existsSync(path.join(root, "build/server/worker.cjs"))) {
  console.error("build/server/worker.cjs introuvable : lancez d'abord « npm run build ».");
  process.exit(1);
}
const arg = (f: string) => { const i = ARGS.indexOf(f); return i >= 0 ? ARGS[i + 1] : undefined; };
const DB = `kareer_e2e_worker_${process.pid}`;
const U = "00000000-0000-0000-0000-0000000000e2";

const results: { label: string; ok: boolean }[] = [];
const check = (label: string, cond: unknown, detail = "") => {
  results.push({ label, ok: !!cond });
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}${!cond && detail ? ` — ${detail}` : ""}`);
};

execFileSync("psql", [...ARGS, "-d", "postgres", "-qc", `drop database if exists ${DB}`, "-c", `create database ${DB}`]);
for (const f of ["tests/sql/supabase-shim.sql", "supabase/migrations/001_init.sql", "supabase/migrations/002_automation.sql"]) {
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
await q("insert into public.profiles (id, data) values ($1, $2)", [U, profile]);
await q(`insert into public.automation_policies (user_id, enabled, roles, locations, min_fit, channels, daily_limit)
         values ($1, true, '{développeur}', '{Avignon}', 30, '{email,form}', 5)`, [U]);
await q(`insert into public.mail_connections (user_id, provider, email, access_token_enc, refresh_token_enc, expires_at)
         values ($1, 'gmail', 'karim@gmail.com', $2, $3, now() + interval '1 hour')`, [U, encryptToken("jeton-acces-karim"), encryptToken("jeton-refresh")]);

const mock = await startMockSources(MOCK_PORT);
const workerEnv = {
  ...e2eServerEnv(),
  NODE_ENV: "production",
  AUTOMATION_DATABASE_URL: dbUrl,
  AUTOMATION_TOKEN_KEY: process.env.AUTOMATION_TOKEN_KEY,
  AUTOMATION_POLL_SECONDS: "5",
  GMAIL_API_URL: `http://localhost:${MOCK_PORT}/gmail/send`
};
let log = "";
const startWorker = (): ChildProcess => {
  const w = spawn(process.execPath, ["build/server/worker.cjs"], { cwd: root, env: workerEnv, stdio: ["ignore", "pipe", "pipe"] });
  w.stdout!.on("data", (d) => (log += d));
  w.stderr!.on("data", (d) => (log += d));
  return w;
};
const waitFor = async (cond: () => Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 1000)); }
  return false;
};
const stop = (w: ChildProcess) => new Promise<void>((r) => { w.once("exit", () => r()); w.kill("SIGTERM"); });

try {
  console.log("\nWorker d'auto-candidature (processus réel)");
  let worker = startWorker();
  const done = await waitFor(async () => {
    const [r] = await q(`select count(*)::int as n from public.automation_tasks where kind = 'process_offer' and status in ('queued', 'running')`);
    const [s] = await q(`select count(*)::int as n from public.automation_tasks where kind = 'search' and status = 'done'`);
    return s.n > 0 && r.n === 0;
  }, 120_000);
  check("recherche planifiée puis toutes les offres traitées", done, log.slice(-600));

  const sent = mailbox;
  check("une candidature envoyée par email (offre qui publie son adresse)", sent.length === 1, `${sent.length} message(s)`);
  const raw = sent[0]?.raw || "";
  check("depuis la boîte du candidat, à l'adresse publiée par l'offre", /^From: .*<karim@gmail\.com>/m.test(raw) && /^To: recrutement@datasud\.fr$/m.test(raw), raw.slice(0, 300));
  check("jeton d'accès du candidat utilisé (déchiffré par le worker)", sent[0]?.auth === "Bearer jeton-acces-karim");
  const pdfPart = raw.split(/--kareer-[0-9a-f]+/).find((p: string) => /application\/pdf/.test(p)) || "";
  const pdf = Buffer.from(pdfPart.split("\r\n\r\n")[1]?.replace(/\r\n/g, "") || "", "base64");
  check("CV joint en PDF", pdf.subarray(0, 4).toString() === "%PDF", `${pdf.length} octets`);
  const bodyPart = raw.split(/--kareer-[0-9a-f]+/).find((p: string) => /text\/plain/.test(p)) || "";
  const letter = Buffer.from(bodyPart.split("\r\n\r\n")[1]?.replace(/\r\n/g, "") || "", "base64").toString();
  check("lettre de motivation dans le message", /Madame, Monsieur/.test(letter), letter.slice(0, 120));

  const [att] = await q(`select status, proof->>'messageId' as mid, destination from public.application_attempts`);
  check("tentative prouvée (identifiant du message Gmail)", att?.status === "submitted" && att?.mid === "gmail-1", JSON.stringify(att));
  const apps = await q(`select status, data->>'jobTitle' as title, data->'automation'->>'state' as state, data->'automation'->>'reason' as reason from public.applications where user_id = $1`, [U]);
  check("dossier « envoyée » visible dans Candidatures", apps.some((a) => a.status === "applied" && a.state === "submitted"));
  check("offres sans adresse ni formulaire reconnu : dossier prêt, action demandée", apps.some((a) => a.state === "needs_user" && /(Indeed|LinkedIn|Welcome|France Travail|La bonne alternance|Jooble|Adzuna|non pris en charge)/.test(a.reason || "")), JSON.stringify(apps.slice(0, 3)));
  const unrelated = await q(`select count(*)::int as n from public.automation_events where message like 'Offre écartée%'`);
  void unrelated;

  // Redémarrage : aucune candidature renvoyée
  await stop(worker);
  await q(`update public.automation_tasks set run_after = now(), status = 'queued' where kind = 'process_offer'`);
  worker = startWorker();
  await waitFor(async () => (await q(`select 1 from public.automation_tasks where kind = 'process_offer' and status in ('queued', 'running')`)).length === 0, 60_000);
  check("redémarrage et offres remises en file : aucun doublon", mailbox.length === 1, `${mailbox.length} message(s)`);

  // Pause : plus aucun envoi
  await q(`update public.automation_policies set paused = true where user_id = $1`, [U]);
  await q(`delete from public.application_attempts`);
  await q(`update public.automation_tasks set run_after = now(), status = 'queued' where kind = 'process_offer'`);
  await new Promise((r) => setTimeout(r, 8000));
  check("pause : plus aucun envoi", mailbox.length === 1, `${mailbox.length} message(s)`);
  await stop(worker);
  check("aucune erreur du worker", !/automation_worker_error/.test(log), log.match(/.*automation_worker_error.*/)?.[0]);
} catch (e: any) {
  check("exécution sans exception", false, e?.message);
} finally {
  mock.close();
  await pool.end();
  try { execFileSync("psql", [...ARGS, "-d", "postgres", "-qc", `drop database if exists ${DB}`]); } catch { /* base laissée pour diagnostic */ }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} vérifications réussies.`);
process.exit(failed ? 1 : 0);
