/**
 * Test de bout en bout contre le VRAI projet Supabase (.env : SUPABASE_URL, SUPABASE_ANON_KEY,
 * SUPABASE_SERVICE_ROLE_KEY). Crée deux comptes de test, vérifie connexion, profil, candidatures,
 * vérification du jeton par le serveur et cloisonnement (RLS), puis supprime les comptes.
 *
 * Prérequis : build avec VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (npm run build), Chromium.
 * Lancement : node e2e/supabase-live.mjs
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockSources } from './mock-sources.mjs';
import { e2eServerEnv, MOCK_PORT, APP_PORT } from './env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL, SUPABASE_ANON_KEY et SUPABASE_SERVICE_ROLE_KEY requis (.env).');
  process.exit(1);
}
const { chromium } = await import('playwright');

const admin = (p, init = {}) => fetch(`${SUPABASE_URL}${p}`, {
  ...init,
  headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
});
const results = [];
const check = (label, cond, detail = '') => {
  results.push({ label, ok: !!cond });
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${!cond && detail ? ` — ${detail}` : ''}`);
};

const stamp = Date.now();
const users = [
  { email: `e2e-a-${stamp}@example.com`, password: `Test-${stamp}-a!`, name: 'Karim Test' },
  { email: `e2e-b-${stamp}@example.com`, password: `Test-${stamp}-b!`, name: 'Autre Compte' }
];
for (const u of users) {
  const r = await admin('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email: u.email, password: u.password, email_confirm: true, user_metadata: { full_name: u.name, title: 'Développeur' } }) });
  const j = await r.json();
  u.id = j.id;
}
check('comptes de test créés (API admin)', users.every((u) => u.id), JSON.stringify(users.map((u) => u.id)));

const BASE = `http://localhost:${APP_PORT}`;
const mock = await startMockSources(MOCK_PORT);
const server = spawn(process.execPath, ['dist/server.cjs'], {
  cwd: root,
  env: { ...e2eServerEnv(), AUTH_MODE: 'required', SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });

try {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let wsBlocked = false;
  page.on('websocket', (ws) => ws.on('socketerror', () => { wsBlocked = true; }));
  await page.goto(BASE);
  await page.waitForTimeout(1000);

  // Connexion par e-mail
  await page.getByRole('button', { name: 'Connexion', exact: true }).click();
  await page.getByLabel('Adresse e-mail').fill(users[0].email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(users[0].password);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).last().click();
  await page.waitForTimeout(3000);
  const hasSession = await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('sb-') && k.endsWith('-auth-token')));
  check('connexion : session Supabase ouverte', hasSession);

  // Nouveau compte : profil créé en base avec le nom de l'inscription, import du CV demandé
  await page.waitForTimeout(1000);
  let rows = await (await admin(`/rest/v1/profiles?id=eq.${users[0].id}&select=data`)).json();
  check('profil créé en base (nom de l’inscription)', rows[0]?.data?.fullName === 'Karim Test', JSON.stringify(rows).slice(0, 200));

  // Import du CV (texte collé) → profil complété en base
  const importBtn = page.getByRole('button', { name: 'Coller le texte' });
  if (!(await importBtn.isVisible().catch(() => false))) await page.getByRole('button', { name: /Importer mon CV/ }).first().click();
  await page.getByRole('button', { name: 'Coller le texte' }).click();
  await page.getByLabel('Texte complet de votre CV').fill(`Karim Test\nDéveloppeur Full Stack\nkarim@mail.fr\nEXPÉRIENCES PROFESSIONNELLES\nDéveloppeur - Studio X | 2021 - Présent\nDéveloppement React et Node.js, API REST\nCOMPÉTENCES\nReact, TypeScript, Python, Node.js`);
  await page.getByRole('button', { name: /Analyser mon CV/ }).click();
  await page.getByRole('button', { name: /Confirmer et enregistrer/ }).click({ timeout: 20000 });
  await page.waitForTimeout(2000);
  rows = await (await admin(`/rest/v1/profiles?id=eq.${users[0].id}&select=data`)).json();
  check('CV importé : expériences et compétences en base', (rows[0]?.data?.experiences || []).length > 0 && (rows[0]?.data?.skills || []).includes('React'));
  // Génération d'un CV par l'IA (faux Gemini) avec le jeton du compte → décomptée dans la table usage
  const usageApi = await page.evaluate(async () => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('sb-') && x.endsWith('-auth-token'));
    const token = k ? JSON.parse(localStorage.getItem(k)).access_token : '';
    const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const candidate = { fullName: 'Karim Test', skills: ['React'], experiences: [{ id: 'exp-1', title: 'Développeur', company: 'Studio X', bullets: ['Développé des interfaces React'] }] };
    const gen = await fetch('/api/tailor/latex', { method: 'POST', headers: h, body: JSON.stringify({ candidate, job: { title: 'Développeur React', company: 'ACME', description: 'React', skillsRequired: ['React'] } }) }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 1500));
    const usage = await fetch('/api/account/usage', { headers: h }).then((r) => r.json());
    return { source: gen.source, usage };
  });
  const usageRows = await (await admin(`/rest/v1/usage?user_id=eq.${users[0].id}&select=kind,count`)).json();
  check('quota : CV généré par l’IA décompté en base (table usage)', usageApi.source === 'gemini-pipeline' && usageRows.some((u) => u.kind === 'cv' && u.count === 1), JSON.stringify({ source: usageApi.source, usageRows }));
  check('API /api/account/usage : forfait gratuit et consommation du compte', usageApi.usage.plan === 'free' && usageApi.usage.account === true && usageApi.usage.usage.cv === 1, JSON.stringify(usageApi.usage).slice(0, 200));
  check('API IA en mode « compte requis » : jeton accepté (analyse du CV)', !/401/.test(log) && rows[0]?.data?.experiences?.length > 0);

  // Sauvegarde d'une offre → ligne dans applications
  const viewOffers = page.getByRole('button', { name: /Voir les offres/ });
  if (await viewOffers.isVisible().catch(() => false)) await viewOffers.click();
  await page.getByLabel('Métier ou mot-clé').fill('développeur');
  await page.getByLabel('Lieu', { exact: true }).fill('Avignon');
  await page.getByLabel('Lieu', { exact: true }).press('Enter');
  await page.waitForTimeout(1500);
  await page.locator('article', { hasText: 'Front-End React' }).locator('button[aria-label^="Sauvegarder"]').click();
  await page.waitForTimeout(2000);
  const apps = await (await admin(`/rest/v1/applications?user_id=eq.${users[0].id}&select=id,status,data`)).json();
  check('offre sauvegardée : candidature en base', apps.length === 1 && apps[0].status === 'detected', JSON.stringify(apps).slice(0, 200));

  // Changement de statut depuis la base (autre appareil) → visible dans l'interface (temps réel)
  if (apps[0]) {
    await admin(`/rest/v1/applications?user_id=eq.${users[0].id}&id=eq.${encodeURIComponent(apps[0].id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ data: { ...apps[0].data, status: 'applied', appliedAt: new Date().toISOString() } })
    });
    await page.locator('header nav button', { hasText: 'Candidatures' }).click();
    await page.waitForTimeout(3500);
    const body = await page.textContent('body');
    if (wsBlocked) console.log('  ⚠ temps réel non testable ici : WebSocket bloqué par le réseau (repli : rechargement au retour sur l’onglet)');
    else check('synchronisation temps réel (modification faite ailleurs)', /Déposée/.test(body));
  }

  // Rechargement : la session et les données reviennent
  await page.reload();
  await page.waitForTimeout(3000);
  const bodyAfter = await page.textContent('body');
  check('rechargement : session et candidatures conservées', /Front-End React/.test(bodyAfter));

  // Cloisonnement : le compte B ne voit rien du compte A
  const tok = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: users[1].email, password: users[1].password })
  })).json();
  const asB = (p) => fetch(`${SUPABASE_URL}${p}`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
  const bProfiles = await asB(`/rest/v1/profiles?select=id`);
  const bApps = await asB(`/rest/v1/applications?select=id`);
  check('RLS : un autre compte ne voit ni le profil ni les candidatures', Array.isArray(bProfiles) && bProfiles.every((p) => p.id === users[1].id) && Array.isArray(bApps) && bApps.length === 0, JSON.stringify({ bProfiles, bApps }).slice(0, 200));
  const bWrite = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
    method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: users[1].id, plan: 'premium' })
  });
  check('RLS : impossible de s’attribuer le forfait Premium soi-même', bWrite.status >= 400, `statut ${bWrite.status}`);
  const anonRead = await (await fetch(`${SUPABASE_URL}/rest/v1/applications?select=id`, { headers: { apikey: SUPABASE_ANON_KEY } })).json();
  check('RLS : aucune donnée lisible sans connexion', Array.isArray(anonRead) && anonRead.length === 0);

  // RGPD : export puis suppression du compte B par l'utilisateur lui-même (API du serveur)
  const asBServer = (p, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: { Authorization: `Bearer ${tok.access_token}` } });
  const exp = await (await asBServer('/api/account/export')).json();
  check('RGPD : export des données du compte', exp.account?.id === users[1].id && 'profile' in exp && Array.isArray(exp.applications), JSON.stringify(exp).slice(0, 160));
  const del = await asBServer('/api/account', { method: 'DELETE' });
  const gone = await admin(`/auth/v1/admin/users/${users[1].id}`);
  check('RGPD : suppression du compte par l’utilisateur', del.status === 200 && gone.status === 404, `suppression ${del.status}, lecture ${gone.status}`);

  // Déconnexion
  await page.locator('header').getByRole('button', { name: /Karim|Compte|menu/i }).first().click().catch(() => {});
  const logout = page.getByRole('menuitem', { name: /Déconnexion|Se déconnecter/ }).or(page.getByRole('button', { name: /Déconnexion|Se déconnecter/ }));
  if (await logout.first().isVisible().catch(() => false)) {
    await logout.first().click();
    await page.waitForTimeout(1500);
    const stillSession = await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('sb-') && k.endsWith('-auth-token')));
    check('déconnexion : session fermée', !stillSession);
  }
  check('aucune erreur JavaScript', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('exécution sans exception', false, e?.message);
} finally {
  await browser.close();
  server.kill();
  mock.close();
  for (const u of users) if (u.id) await admin(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' });
  const left = await (await admin(`/rest/v1/profiles?id=in.(${users.map((u) => u.id).join(',')})&select=id`)).json();
  check('comptes de test supprimés (profils effacés en cascade)', Array.isArray(left) && left.length === 0);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} vérifications réussies.`);
process.exit(failed ? 1 : 0);
