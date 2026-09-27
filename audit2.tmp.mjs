import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { startMockSources } from './e2e/mock-sources.mjs';
import { e2eServerEnv, MOCK_PORT, APP_PORT } from './e2e/env.mjs';
const mock = await startMockSources(MOCK_PORT);
const server = spawn(process.execPath, ['build/server/server.cjs'], { env: { ...e2eServerEnv(), PW_CHROMIUM_PATH: process.env.PW_CHROMIUM_PATH }, stdio: 'ignore' });
const BASE = `http://localhost:${APP_PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH });
const p = await b.newPage({ viewport: { width: 1366, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
const shot = (n) => p.screenshot({ path: `/tmp/claude-0/audit/${n}.png` });
const T = async (label, fn) => { const t = Date.now(); try { await fn(); console.log(`✓ ${label} (${Date.now() - t} ms)`); } catch (e) { console.log(`✗ ${label} : ${String(e.message).split('\n')[0].slice(0, 160)}`); await shot('ERR-' + label.replace(/\W+/g, '_').slice(0, 40)); } };
try {
  await T('accueil', async () => { await p.goto(BASE, { waitUntil: 'networkidle' }); await shot('10-accueil'); });
  await T('recherche développeur Avignon', async () => {
    await p.fill('input[placeholder*="Métier"]', 'développeur'); await p.fill('input[placeholder*="Ville"]', 'Avignon');
    await p.getByRole('button', { name: 'Rechercher' }).click(); await p.waitForTimeout(3500); await shot('11-resultats');
    console.log('   ', (await p.locator('main').innerText()).match(/\d+ offres?[^\n]*/)?.[0]);
  });
  await T('import CV (texte collé)', async () => {
    await p.getByRole('button', { name: /Importer mon CV|Importer/ }).first().click(); await p.waitForTimeout(600);
    await p.getByRole('button', { name: /Coller le texte/ }).click();
    await p.locator('textarea').first().fill(`Camille Martin\nDéveloppeuse web\ncamille@example.com — 06 12 34 56 78 — Avignon\n\nEXPÉRIENCE\nDéveloppeuse web — Studio X — 2022 - aujourd'hui\n- Développement d'interfaces React et TypeScript\n- API Node.js et PostgreSQL\n\nFORMATION\nLicence informatique — Université d'Avignon — 2022\n\nCOMPÉTENCES\nReact, TypeScript, Node.js, Git, Docker`);
    await p.getByRole('button', { name: /Analyser/ }).click(); await p.waitForTimeout(4000); await shot('12-import-resultat');
    const save = p.getByRole('button', { name: /Enregistrer|Valider|Confirmer/ }).first();
    if (await save.count()) { await save.click(); await p.waitForTimeout(1500); }
    await shot('13-apres-import');
  });
  await T('ouvrir une offre et préparer CV + lettre', async () => {
    await p.goto(`${BASE}/?q=d%C3%A9veloppeur&lieu=Avignon`, { waitUntil: 'networkidle' }); await p.waitForTimeout(3000);
    await p.locator('article, [role=listitem], li').filter({ hasText: /React/ }).first().click().catch(() => {});
    await p.waitForTimeout(1000); await shot('14-fiche-offre');
    const btn = p.getByRole('button', { name: /CV \+ lettre|Adapter|Préparer/ }).first();
    await btn.click(); await p.waitForTimeout(6000); await shot('15-studio');
  });
  for (const [tab, n] of [['Candidatures', '16-candidatures'], ['Entretiens', '17-entretiens'], ['Assistant', '18-assistant'], ['Studio CV', '19-studio-cv'], ['Profil', '20-profil'], ['Outils', '21-outils']]) {
    await T('onglet ' + tab, async () => { await p.getByRole('navigation').getByText(tab, { exact: true }).first().click(); await p.waitForTimeout(1800); await shot(n); });
  }
  await T('tarifs', async () => { await p.goto(`${BASE}/?onglet=tarifs`, { waitUntil: 'networkidle' }); await p.waitForTimeout(1200); await shot('22-tarifs'); });
  const m = await b.newPage({ viewport: { width: 390, height: 844 } });
  await T('mobile accueil', async () => { await m.goto(BASE, { waitUntil: 'networkidle' }); await m.waitForTimeout(1500); await m.screenshot({ path: '/tmp/claude-0/audit/23-mobile.png' }); });
} finally {
  console.log('erreurs JS', errs.slice(0, 8));
  await b.close(); server.kill(); mock.close();
}
