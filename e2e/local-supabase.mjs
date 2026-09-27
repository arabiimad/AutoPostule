/**
 * Supabase local pour les tests de comptes (sans projet Supabase ni clé) :
 *   PostgreSQL (AUTOMATION_PG) + GoTrue (comptes) + PostgREST (API) en conteneurs Docker (réseau hôte),
 *   une passerelle /auth/v1 et /rest/v1 comme Supabase, et un serveur SMTP qui capture les e-mails envoyés.
 *
 *   AUTOMATION_PG="-h /var/tmp/kareer-pg -p 5433 -U postgres" node e2e/local-supabase.mjs
 *
 * Lance ensuite e2e/supabase-live.mjs (comptes, RLS, RGPD) puis e2e/accounts.e2e.mjs (confirmation,
 * mot de passe oublié, session expirée) contre cette pile. Tout est arrêté et supprimé à la fin.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = (process.env.AUTOMATION_PG || '').split(/\s+/).filter(Boolean);
if (!ARGS.length) { console.error('AUTOMATION_PG manquant.'); process.exit(1); }
const arg = (f) => { const i = ARGS.indexOf(f); return i >= 0 ? ARGS[i + 1] : undefined; };
const PG_PORT = arg('-p') || '5432';
const DB = `kareer_accounts_${process.pid}`;
// Base protégée par mot de passe (CI) : même mot de passe pour les rôles de connexion des conteneurs
const PW = process.env.PGPASSWORD || '';
const cred = (role) => (PW ? `${role}:${encodeURIComponent(PW)}` : role);
const psql = (sql, db = DB) => execFileSync('psql', [...ARGS, '-d', db, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', sql]).toString().trim();
const psqlFile = (f) => execFileSync('psql', [...ARGS, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f], { stdio: ['ignore', 'ignore', 'pipe'] });

const JWT_SECRET = 'secret-local-de-test-au-moins-32-caracteres!!';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => { const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64(payload); return `${h}.${p}.${createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const ANON_KEY = jwt({ role: 'anon', iss: 'supabase', iat: 1700000000, exp: 2000000000 });
const SERVICE_KEY = jwt({ role: 'service_role', iss: 'supabase', iat: 1700000000, exp: 2000000000 });
const GATEWAY_PORT = 54321, GOTRUE_PORT = 54322, REST_PORT = 54323, SMTP_PORT = 54325;
const GATEWAY = `http://localhost:${GATEWAY_PORT}`;
const APP_PORT = Number(process.env.E2E_PORT) || 3107;

// --- E-mails capturés -------------------------------------------------------------------------------------
export const mails = [];
const smtp = net.createServer((sock) => {
  let data = false, buf = '', msg = '';
  sock.write('220 kareer.test ESMTP\r\n');
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data) {
        if (line === '.') { data = false; mails.push(msg); msg = ''; sock.write('250 OK\r\n'); } else msg += `${line.startsWith('..') ? line.slice(1) : line}\n`;
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-kareer.test\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (cmd === 'AUTH') sock.write('235 OK\r\n');
      else if (cmd === 'DATA') { data = true; sock.write('354 Go\r\n'); }
      else if (cmd === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
      else sock.write('250 OK\r\n');
    }
  });
});
await new Promise((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));
fs.writeFileSync(path.join(os.tmpdir(), 'kareer-mails.json'), '[]');
setInterval(() => fs.writeFileSync(path.join(os.tmpdir(), 'kareer-mails.json'), JSON.stringify(mails)), 300).unref();

// --- Base : rôles Supabase, puis GoTrue crée le schéma auth ------------------------------------------------
execFileSync('psql', [...ARGS, '-d', 'postgres', '-qc', `drop database if exists ${DB}`, '-c', `create database ${DB}`]);
psql(`do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin login createrole superuser; end if;
end $$;
${PW ? `alter role authenticator password '${PW.replace(/'/g, "''")}'; alter role supabase_auth_admin password '${PW.replace(/'/g, "''")}';` : ''}
grant anon, authenticated, service_role to authenticator;
create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
create publication supabase_realtime;`);

const containers = [];
const docker = (name, image, env) => {
  execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  execFileSync('docker', ['run', '-d', '--name', name, '--network', 'host', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), image], { stdio: 'ignore' });
  containers.push(name);
};
docker('kareer-gotrue', 'supabase/gotrue:v2.170.0', {
  GOTRUE_API_HOST: '127.0.0.1', PORT: GOTRUE_PORT, API_EXTERNAL_URL: `${GATEWAY}/auth/v1`,
  GOTRUE_DB_DRIVER: 'postgres', GOTRUE_DB_DATABASE_URL: `postgres://${cred('supabase_auth_admin')}@127.0.0.1:${PG_PORT}/${DB}?sslmode=disable&search_path=auth`,
  GOTRUE_SITE_URL: `http://localhost:${APP_PORT}`, GOTRUE_URI_ALLOW_LIST: '*', GOTRUE_DISABLE_SIGNUP: 'false',
  GOTRUE_JWT_SECRET: JWT_SECRET, GOTRUE_JWT_EXP: process.env.GOTRUE_JWT_EXP || '3600', GOTRUE_JWT_AUD: 'authenticated',
  GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated', GOTRUE_JWT_ADMIN_ROLES: 'service_role',
  GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true', GOTRUE_MAILER_AUTOCONFIRM: 'false', GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED: 'false',
  GOTRUE_SMTP_HOST: '127.0.0.1', GOTRUE_SMTP_PORT: SMTP_PORT, GOTRUE_SMTP_USER: 'x', GOTRUE_SMTP_PASS: 'x', GOTRUE_SMTP_ADMIN_EMAIL: 'noreply@kareer.test',
  // Chemins des liens envoyés par e-mail (comme Supabase hébergé : derrière /auth/v1)
  GOTRUE_MAILER_URLPATHS_CONFIRMATION: '/auth/v1/verify', GOTRUE_MAILER_URLPATHS_RECOVERY: '/auth/v1/verify',
  GOTRUE_MAILER_URLPATHS_INVITE: '/auth/v1/verify', GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: '/auth/v1/verify',
  GOTRUE_RATE_LIMIT_EMAIL_SENT: '1000', GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: 'true', GOTRUE_LOG_LEVEL: 'warn'
});

const wait = async (url, label) => {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* démarrage */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} ne démarre pas : ${execFileSync('docker', ['logs', '--tail', '30', containers.at(-1)]).toString()}`);
};
await wait(`http://127.0.0.1:${GOTRUE_PORT}/health`, 'GoTrue');

// Droits de Supabase hébergé sur le schéma auth (auth.uid() dans les règles RLS et les fonctions)
psql(`grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;`);

// Schéma de l'application (mêmes migrations qu'en production)
for (const f of ['001_init.sql', '002_automation.sql', '003_push.sql', '004_sync.sql', '005_billing.sql', '006_lba_channel.sql']) psqlFile(path.join(root, 'supabase/migrations', f));

docker('kareer-postgrest', 'postgrest/postgrest:v12.2.3', {
  PGRST_DB_URI: `postgres://${cred('authenticator')}@127.0.0.1:${PG_PORT}/${DB}`, PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon',
  PGRST_JWT_SECRET: JWT_SECRET, PGRST_SERVER_PORT: REST_PORT, PGRST_SERVER_HOST: '127.0.0.1', PGRST_DB_CHANNEL_ENABLED: 'true'
});
await wait(`http://127.0.0.1:${REST_PORT}/`, 'PostgREST');

// --- Passerelle façon Supabase ----------------------------------------------------------------------------
const gateway = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range, X-Total-Count' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const m = /^\/(auth|rest)\/v1(\/.*)?$/.exec(req.url.split('?')[0]);
  if (!m) { res.writeHead(404, cors); return res.end('{}'); }
  const port = m[1] === 'auth' ? GOTRUE_PORT : REST_PORT;
  const target = (m[2] || '/') + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  const up = http.request({ host: '127.0.0.1', port, path: target, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (r) => {
    // En-têtes CORS de la passerelle seulement (comme Supabase) : pas de doublon avec ceux de GoTrue / PostgREST
    const headers = Object.fromEntries(Object.entries(r.headers).filter(([k]) => !k.toLowerCase().startsWith('access-control-')));
    res.writeHead(r.statusCode, { ...headers, ...cors });
    r.pipe(res);
  });
  up.on('error', () => { res.writeHead(502, cors); res.end('{}'); });
  req.pipe(up);
});
await new Promise((r) => gateway.listen(GATEWAY_PORT, '127.0.0.1', r));

// --- Application construite pour ces comptes (dossier séparé : le build local reste intact) ------------------
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kareer-cloud-'));
execFileSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', path.join(appDir, 'dist'), '--emptyOutDir'], {
  cwd: root, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: GATEWAY, VITE_SUPABASE_ANON_KEY: ANON_KEY }
});

const env = {
  ...process.env, SUPABASE_URL: GATEWAY, SUPABASE_ANON_KEY: ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  E2E_APP_CWD: appDir, E2E_MAILS: path.join(os.tmpdir(), 'kareer-mails.json'), E2E_DB: DB
};
// Diagnostic : pile laissée en marche (E2E_SERVE=1), sans lancer les tests
if (process.env.E2E_SERVE) {
  fs.writeFileSync(path.join(os.tmpdir(), 'kareer-stack.json'), JSON.stringify({ gateway: GATEWAY, anon: ANON_KEY, service: SERVICE_KEY, appDir, db: DB }));
  console.log('Pile prête', GATEWAY);
  await new Promise(() => {});
}
let failed = 0;
for (const script of ['e2e/supabase-live.mjs', 'e2e/accounts.e2e.mjs'].filter((s) => !process.env.E2E_ONLY || s.includes(process.env.E2E_ONLY))) {
  console.log(`\n=== ${script}`);
  const code = await new Promise((resolve) => spawn(process.execPath, [script], { cwd: root, env, stdio: 'inherit' }).on('exit', resolve));
  if (code) failed++;
}

for (const c of containers) execFileSync('docker', ['rm', '-f', c], { stdio: 'ignore' });
gateway.close(); smtp.close();
fs.rmSync(appDir, { recursive: true, force: true });
try { execFileSync('psql', [...ARGS, '-d', 'postgres', '-qc', `drop database if exists ${DB} with (force)`]); } catch { /* diagnostic */ }
process.exit(failed ? 1 : 0);
