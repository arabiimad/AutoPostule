/**
 * Parcours de compte réels (lancés par e2e/local-supabase.mjs, pile Supabase locale) :
 * inscription avec confirmation par e-mail, connexion refusée avant confirmation, mot de passe oublié
 * (lien reçu → nouveau mot de passe → connexion), session expirée renouvelée, session révoquée.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockSources } from './mock-sources.mjs';
import { e2eServerEnv, MOCK_PORT, APP_PORT } from './env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, E2E_APP_CWD, E2E_MAILS } = process.env;
if (!SUPABASE_URL || !E2E_MAILS) { console.error('À lancer via e2e/local-supabase.mjs'); process.exit(1); }
const { chromium } = await import('playwright');
const admin = (p, init = {}) => fetch(`${SUPABASE_URL}${p}`, { ...init, headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });

const results = [];
const check = (label, cond, detail = '') => { results.push({ label, ok: !!cond }); console.log(`${cond ? '  ✓' : '  ✗'} ${label}${!cond && detail ? ` — ${detail}` : ''}`); };
const mailsTo = (email) => JSON.parse(fs.readFileSync(E2E_MAILS, 'utf8')).filter((m) => m.includes(email));
/** Lien d'action (confirmation, récupération) contenu dans le dernier e-mail reçu (HTML en quoted-printable). */
const linkIn = (mail) => {
  const flat = mail.replace(/=\r?\n/g, '').replace(/=3D/g, '=').replace(/&amp;/g, '&');
  return flat.match(/https?:\/\/[^\s"'<>]+\/verify\?[^\s"'<>]+/)?.[0] || null;
};
const waitMail = async (email, n = 1) => { for (let i = 0; i < 40; i++) { if (mailsTo(email).length >= n) return mailsTo(email).at(-1); await new Promise((r) => setTimeout(r, 250)); } return null; };

const BASE = `http://localhost:${APP_PORT}`;
const mock = await startMockSources(MOCK_PORT);
const server = spawn(process.execPath, [path.join(root, 'build/server/server.cjs')], {
  cwd: E2E_APP_CWD || root, env: { ...e2eServerEnv(), AUTH_MODE: 'required', SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY }, stdio: ['ignore', 'pipe', 'pipe']
});
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });
const stamp = Date.now();
const email = `nouveau-${stamp}@example.com`;
const password = `Kareer-${stamp}-1`;
const hasSession = (page) => page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('sb-') && k.endsWith('-auth-token')));

try {
  console.log('\nComptes : inscription, confirmation, mot de passe oublié, session');
  const ctx = await browser.newContext({ locale: 'fr-FR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForTimeout(800);

  // Inscription : pas de session tant que l'adresse n'est pas confirmée
  await page.getByRole('button', { name: 'Créer un compte' }).first().click();
  await page.getByLabel(/Nom et prénom/).fill('Nina Test');
  await page.getByLabel(/^Adresse e-mail/).fill(email);
  await page.getByLabel(/^Mot de passe/).first().fill(password);
  await page.getByLabel(/Confirmer le mot de passe/).fill(password);
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await page.getByText(/Un lien de confirmation a été envoyé/).waitFor({ timeout: 15000 });
  check('inscription : lien de confirmation annoncé, pas encore de session', !(await hasSession(page)));
  const confirmMail = await waitMail(email);
  const confirmLink = confirmMail && linkIn(confirmMail);
  check('e-mail de confirmation reçu avec un lien', !!confirmLink, confirmMail?.slice(0, 200));

  // Connexion avant confirmation : refusée avec un message clair
  await page.getByRole('button', { name: 'Se connecter', exact: true }).first().click();
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).last().click();
  await page.waitForTimeout(1500);
  check('connexion avant confirmation : refusée, message clair', /non confirmée/.test(await page.getByRole('dialog').innerText()));

  // Lien de confirmation : compte actif et connecté, profil créé avec le nom de l'inscription
  await page.goto(confirmLink);
  await page.waitForTimeout(2500);
  check('lien de confirmation : connecté(e)', await hasSession(page));
  const users = await (await admin('/auth/v1/admin/users?per_page=200')).json();
  const me = (users.users || []).find((u) => u.email === email);
  check('adresse confirmée côté comptes', !!me?.email_confirmed_at);
  const prof = await (await admin(`/rest/v1/profiles?id=eq.${me?.id}&select=data`)).json();
  check('profil créé avec le nom de l’inscription', prof?.[0]?.data?.fullName === 'Nina Test', JSON.stringify(prof).slice(0, 160));
  await page.keyboard.press('Escape').catch(() => {});

  // Mot de passe oublié : lien reçu → écran « nouveau mot de passe » → connexion avec le nouveau
  const ctx2 = await browser.newContext({ locale: 'fr-FR' });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(BASE);
  await p2.waitForTimeout(800);
  await p2.getByRole('button', { name: 'Connexion', exact: true }).click();
  await p2.getByRole('button', { name: /Mot de passe oublié/ }).click();
  await p2.getByLabel('Adresse e-mail du compte').fill(email);
  await p2.getByRole('button', { name: 'Envoyer le lien de réinitialisation' }).click();
  const resetMail = await waitMail(email, 2);
  const resetLink = resetMail && linkIn(resetMail);
  check('e-mail de réinitialisation reçu', !!resetLink && /type=recovery/.test(resetLink), resetLink || '');
  await p2.goto(resetLink);
  await p2.getByText('Choisissez un nouveau mot de passe').waitFor({ timeout: 15000 }).catch(() => {});
  check('lien de réinitialisation : écran « nouveau mot de passe »', await p2.getByText('Choisissez un nouveau mot de passe').isVisible());
  const newPassword = `Nouveau-${stamp}-2`;
  await p2.getByLabel('Nouveau mot de passe', { exact: true }).and(p2.locator('input')).fill(newPassword);
  await p2.getByLabel('Confirmez le mot de passe').fill(newPassword);
  await p2.getByRole('button', { name: /Enregistrer le nouveau mot de passe/ }).click();
  await p2.getByText('Mot de passe modifié').waitFor({ timeout: 10000 }).catch(() => {});
  check('nouveau mot de passe enregistré', await p2.getByText('Mot de passe modifié').isVisible());
  const tokenOld = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const tokenNew = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: newPassword }) });
  check('ancien mot de passe refusé, nouveau accepté', tokenOld.status === 400 && tokenNew.status === 200, `${tokenOld.status}/${tokenNew.status}`);

  // Session expirée : le jeton d'accès est renouvelé automatiquement (reste connecté)
  await p2.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('sb-') && x.endsWith('-auth-token'));
    const s = JSON.parse(localStorage.getItem(k));
    s.expires_at = Math.floor(Date.now() / 1000) - 60;
    localStorage.setItem(k, JSON.stringify(s));
  });
  await p2.reload();
  await p2.waitForTimeout(2500);
  const renewed = await p2.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('sb-') && x.endsWith('-auth-token'));
    return k ? JSON.parse(localStorage.getItem(k)).expires_at > Date.now() / 1000 : false;
  });
  check('session expirée : jeton renouvelé automatiquement', renewed);

  // Session révoquée (déconnexion de tous les appareils) : plus de session après expiration
  await admin(`/auth/v1/admin/users/${me.id}/factors`).catch(() => {});
  await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=global`, { method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${(await tokenNew.json()).access_token}` } });
  await p2.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('sb-') && x.endsWith('-auth-token'));
    const s = JSON.parse(localStorage.getItem(k));
    s.expires_at = Math.floor(Date.now() / 1000) - 60;
    localStorage.setItem(k, JSON.stringify(s));
  });
  await p2.reload();
  await p2.waitForTimeout(2500);
  check('session révoquée : l’appareil est déconnecté', !(await hasSession(p2)));
  check('aucune erreur JavaScript', errors.length === 0, errors.slice(0, 3).join(' | '));
  if (me?.id) await admin(`/auth/v1/admin/users/${me.id}`, { method: 'DELETE' });
} catch (e) {
  check('exécution sans exception', false, e?.message);
} finally {
  await browser.close();
  server.kill();
  mock.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} vérifications réussies.`);
process.exit(failed ? 1 : 0);
