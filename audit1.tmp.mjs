import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1366, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
const shot = async (n) => p.screenshot({ path: `/tmp/claude-0/audit/${n}.png` });
const t0 = Date.now();
await p.goto('http://127.0.0.1:3996/', { waitUntil: 'networkidle' });
console.log('chargement accueil ms', Date.now() - t0);
await shot('01-accueil');
// Recherche métier hors IT
await p.fill('input[placeholder*="Métier"]', 'aide-soignant');
await p.fill('input[placeholder*="Ville"]', 'Lyon');
await p.getByRole('button', { name: 'Rechercher' }).click();
await p.waitForTimeout(4000);
await shot('02-recherche-aide-soignant');
console.log('résultats :', (await p.locator('text=/\\d+ offres/').first().innerText().catch(() => '?')));
const firstTitles = await p.locator('h3').allInnerTexts().catch(() => []);
console.log('premiers titres :', firstTitles.slice(0, 6));
// Onglets
for (const [tab, n] of [['CV', '03-cv'], ['Outils', '04-outils'], ['Profil', '05-profil'], ['Suivi', '06-suivi'], ['Entretiens', '07-entretiens'], ['Assistant', '08-assistant'], ['Tarifs', '09-tarifs']]) {
  const link = p.getByRole('button', { name: tab, exact: true }).or(p.getByRole('link', { name: tab, exact: true })).first();
  if (await link.count()) { await link.click().catch(() => {}); await p.waitForTimeout(1500); await shot(n); console.log('onglet', tab, 'ok', p.url()); }
  else console.log('onglet', tab, 'absent');
}
console.log('erreurs', errs.slice(0, 10));
await b.close();
