import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { startMockSources } from './e2e/mock-sources.mjs';
import { e2eServerEnv, MOCK_PORT, APP_PORT } from './e2e/env.mjs';
const mock = await startMockSources(MOCK_PORT);
const server = spawn(process.execPath, ['build/server/server.cjs'], { env: { ...e2eServerEnv(), PW_CHROMIUM_PATH: process.env.PW_CHROMIUM_PATH }, stdio: 'ignore' });
const BASE = `http://localhost:${APP_PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH });
const ctx = await b.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
const shot = (n) => p.screenshot({ path: `/tmp/claude-0/audit/${n}.png` });
const T = async (label, fn) => { const t = Date.now(); try { await fn(); console.log(`✓ ${label} (${Date.now() - t} ms)`); } catch (e) { console.log(`✗ ${label} : ${String(e.message).split('\n')[0].slice(0, 180)}`); await shot('ERR-' + label.replace(/\W+/g, '_').slice(0, 40)); await p.keyboard.press('Escape'); } };
const nav = async (tab) => { await p.keyboard.press('Escape'); await p.waitForTimeout(300); await p.locator('header').getByText(tab, { exact: true }).first().click(); await p.waitForTimeout(1800); };
try {
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await T('import CV', async () => {
    await p.getByRole('button', { name: /Importer mon CV/ }).first().click(); await p.waitForTimeout(500);
    await p.getByRole('button', { name: /Coller le texte/ }).click();
    await p.locator('textarea').first().fill(`Camille Martin\nDéveloppeuse web\ncamille@example.com — 06 12 34 56 78 — Avignon\n\nEXPÉRIENCE\nDéveloppeuse web — Studio X — 2022 - aujourd'hui\n- Développement d'interfaces React et TypeScript\n- API Node.js et PostgreSQL\n\nFORMATION\nLicence informatique — Université d'Avignon — 2022\n\nCOMPÉTENCES\nReact, TypeScript, Node.js, Git, Docker`);
    await p.getByRole('button', { name: /Analyser/ }).click(); await p.waitForTimeout(4000);
    console.log('   titre extrait :', await p.getByLabel('Titre professionnel').inputValue().catch(() => '?'));
    await p.getByRole('button', { name: /Confirmer et enregistrer/ }).click(); await p.waitForTimeout(1500); await shot('30-apres-import');
  });
  await T('recherche + score', async () => {
    await p.goto(`${BASE}/?q=d%C3%A9veloppeur&lieu=Avignon`, { waitUntil: 'networkidle' }); await p.waitForTimeout(3500); await shot('31-resultats-profil');
  });
  await T('studio : génération, aperçu, lettre, PDF', async () => {
    await p.getByRole('button', { name: /Préparer CV \+ lettre/ }).first().click(); await p.waitForTimeout(7000);
    await p.getByRole('tab', { name: 'Aperçu' }).click(); await p.waitForTimeout(3000); await shot('32-apercu');
    await p.getByRole('tab', { name: /Lettre/ }).click(); await p.waitForTimeout(800); await shot('33-lettre');
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), p.getByRole('button', { name: /^PDF$/ }).click()]);
    console.log('   PDF téléchargé :', dl.suggestedFilename());
    await p.getByRole('button', { name: /Valider et postuler/ }).click(); await p.waitForTimeout(2000); await shot('34-apres-valider');
  });
  await T('candidatures', async () => { await nav('Candidatures'); await shot('35-candidatures'); });
  await T('entretiens', async () => { await nav('Entretiens'); await shot('36-entretiens'); const btn = p.getByRole('button', { name: /Préparer|Kit|entretien/i }).first(); if (await btn.count()) { await btn.click(); await p.waitForTimeout(6000); await shot('37-kit-entretien'); } });
  await T('assistant', async () => { await nav('Assistant'); await shot('38-assistant'); });
  await T('studio cv (onglet)', async () => { await nav('Studio CV'); await shot('39-studio-onglet'); });
  await T('profil', async () => { await nav('Profil'); await shot('40-profil'); });
  await T('outils', async () => { await nav('Outils'); await shot('41-outils'); });
} finally {
  console.log('erreurs JS', errs.slice(0, 8));
  await b.close(); server.kill(); mock.close();
}
