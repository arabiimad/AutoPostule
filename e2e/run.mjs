/**
 * Tests de bout en bout (navigateur réel, sources d'offres simulées).
 *
 *   npm run build            # construit dist/ (interface + serveur)
 *   npx playwright install chromium   # une seule fois
 *   npm run test:e2e
 *
 * Variables utiles : E2E_HEADED=1 (voir le navigateur), PW_CHROMIUM_PATH (Chromium déjà installé).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockSources } from './mock-sources.mjs';
import { e2eServerEnv, MOCK_PORT, APP_PORT } from './env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(root, 'dist', 'server.cjs'))) {
  console.error('dist/server.cjs introuvable : lancez d’abord « npm run build ».');
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright n’est pas installé : « npm install -D playwright » puis « npx playwright install chromium ».');
  process.exit(1);
}

const BASE = `http://localhost:${APP_PORT}`;
const results = [];
const check = (label, cond, detail = '') => {
  results.push({ label, ok: !!cond });
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${!cond && detail ? ` — ${detail}` : ''}`);
};

// --- Démarrage : sources simulées + serveur de production -------------------------------------------
const mock = await startMockSources(MOCK_PORT);
const server = spawn(process.execPath, ['dist/server.cjs'], { cwd: root, env: e2eServerEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const stopAll = () => { try { server.kill(); } catch {} ; try { mock.close(); } catch {} };
process.on('exit', stopAll);

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({ headless: !process.env.E2E_HEADED, executablePath: process.env.PW_CHROMIUM_PATH || undefined });

try {
  // --- API ------------------------------------------------------------------------------------------
  console.log('\nAPI');
  const sources = await (await fetch(`${BASE}/api/jobs/sources`)).json();
  check('sources réelles détectées + quotas exposés', sources.mode === 'live' && sources.quotas?.jsearch?.limit === 200);

  const docx = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'cv-exemple.docx')).toString('base64');
  const cvRes = await fetch(`${BASE}/api/cv/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileBase64: docx, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  });
  const cv = await cvRes.json();
  check('import d’un CV Word (.docx)', cvRes.ok && /Jeanne/.test(cv.profile?.fullName || '') && (cv.profile?.skills || []).includes('React'), JSON.stringify(cv).slice(0, 160));

  const page2 = await (await fetch(`${BASE}/api/jobs/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'comptable', location: 'Avignon', page: 1 }) })).json();
  check('pagination serveur : d’autres pages annoncées', page2.hasMore === true && page2.jobs.filter((j) => /^Comptable/.test(j.title)).length === 50, `hasMore=${page2.hasMore} total=${page2.total}`);

  // --- Parcours complet (bureau) ---------------------------------------------------------------------
  console.log('\nParcours bureau');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, locale: 'fr-FR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const popups = [];
  ctx.on('page', (p) => popups.push(p));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  check('premiers pas affichés au premier lancement', await page.getByText('Bienvenue sur AutoPostule').isVisible());

  // Import du CV (texte collé)
  await page.getByRole('button', { name: /Importer mon CV/ }).first().click();
  await page.getByRole('button', { name: 'Coller le texte' }).click();
  await page.getByLabel('Texte complet de votre CV').fill(`Karim Dupont\nDéveloppeur Full Stack\nkarim@mail.fr | 06 11 22 33 44\n12 rue de la République 84000 Avignon\nEXPÉRIENCES PROFESSIONNELLES\nDéveloppeur - Studio X | 2021 - Présent\nDéveloppement React et Node.js, API REST\nCOMPÉTENCES\nReact, TypeScript, Python, PostgreSQL, Git, Docker, Node.js, JavaScript`);
  await page.getByRole('button', { name: /Analyser mon CV/ }).click();
  await page.getByRole('button', { name: /Confirmer et enregistrer/ }).click({ timeout: 15000 });
  await page.getByRole('button', { name: /Voir les offres/ }).click();
  check('profil enregistré (premiers pas masqués)', !(await page.getByText('Bienvenue sur AutoPostule').isVisible()));

  // Recherche
  await page.getByLabel('Métier ou mot-clé').fill('développeur');
  await page.getByLabel('Lieu', { exact: true }).fill('Avignon');
  await page.getByLabel('Lieu', { exact: true }).press('Enter');
  await page.waitForTimeout(1500);
  let body = await page.textContent('body');
  check('8 résultats multi-sources (6 offres + 2 entreprises)', /8\s*offres autour de Avignon/.test(body), body.match(/\d+\s*offres?[^.]{0,40}/)?.[0]);
  check('recherche inscrite dans l’URL', /q=d%C3%A9veloppeur/.test(page.url()) && /lieu=Avignon/.test(page.url()));
  check('fiche détaillée ouverte', (await page.locator('aside h2').count()) === 1);
  check('score de compatibilité affiché', (await page.locator('article svg text').count()) > 0);

  // Candidatures spontanées
  await page.getByLabel('Type').selectOption('spontanees');
  await page.waitForTimeout(300);
  body = await page.textContent('body');
  check('filtre « candidatures spontanées »', /2\s*offres/.test(body) && body.includes('MANTIS'));
  await page.locator('article', { hasText: 'MANTIS' }).click();
  body = await page.locator('aside').textContent();
  check('fiche entreprise (secteur, effectif, fiche officielle)', body.includes('Programmation informatique') && body.includes('10-19') && body.includes('Fiche officielle'));
  await page.getByLabel('Type').selectOption('toutes');

  // Lien partageable vers une offre
  await page.locator('article', { hasText: 'Développeur Python' }).click();
  await page.waitForTimeout(200);
  check('offre ouverte inscrite dans l’URL', /offre=ft-201ABC/.test(page.url()));

  // Alerte
  await page.getByRole('button', { name: 'Créer une alerte' }).click();
  await page.waitForTimeout(400);
  check('alerte créée', await page.getByLabel('Mes alertes').isVisible());

  // Sauvegarde + candidature express
  await page.locator('article', { hasText: 'Front-End React' }).locator('button[aria-label^="Sauvegarder"]').click();
  await page.waitForTimeout(300);
  await page.locator('article', { hasText: 'Développeur Python' }).click();
  await page.getByRole('button', { name: /Candidature express/ }).click();
  await page.waitForTimeout(2500);
  check('candidature express : portail ouvert', popups.length >= 1);

  // Précédent du navigateur
  await page.locator('header nav button', { hasText: 'Candidatures' }).click();
  await page.waitForTimeout(300);
  check('onglet dans l’URL', /onglet=candidatures/.test(page.url()));
  await page.goBack();
  await page.waitForTimeout(500);
  check('bouton Précédent : retour aux offres', await page.getByRole('heading', { name: 'Trouvez votre prochaine offre' }).isVisible());
  await page.goForward();
  await page.waitForTimeout(500);

  body = await page.textContent('body');
  check('suivi : 2 candidatures', /Suivies\s*2/.test(body), body.match(/Suivies\s*\d+/)?.[0] || page.url());

  // Photo de CV (facultative) dans le profil
  await page.locator('header nav button', { hasText: 'Profil' }).click();
  await page.getByLabel('Choisir une photo de CV').setInputFiles(path.join(root, 'tests', 'fixtures', 'photo.jpg'));
  await page.waitForTimeout(500);
  check('photo ajoutée au profil', await page.getByAltText('Votre photo de CV').isVisible());
  await page.getByRole('button', { name: /^Enregistrer$/ }).first().click();
  await page.waitForTimeout(500);
  await page.locator('header nav button', { hasText: 'Candidatures' }).click();
  await page.waitForTimeout(400);

  // Studio : nouveau modèle → version archivée
  await page.getByRole('button', { name: /Voir le CV et la lettre/ }).first().click();
  await page.waitForTimeout(1000);
  // Chaîne IA : contenu adapté (faux Gemini), puce inventée écartée, retouche ciblée, rendu sans IA
  check('studio : onglet Contenu (contenu adapté enregistré)', await page.getByRole('tab', { name: 'Contenu' }).isVisible());
  const headline = await page.getByLabel('Titre du CV').inputValue();
  check('titre adapté par l’IA', headline === 'Développeur React — profil adapté', headline);
  const bullets = await page.locator('textarea[aria-label^="Point "]').evaluateAll((els) => els.map((e) => e.value));
  check('garde-fou : « −40 % » inventé écarté', bullets.length > 0 && !bullets.some((b) => /40/.test(b)), bullets.join(' | '));
  await page.getByLabel('Titre du CV').fill('Titre modifié e2e');
  await page.getByRole('button', { name: 'Retoucher le point 1' }).first().click();
  await page.getByRole('button', { name: 'Plus concis' }).click();
  await page.waitForTimeout(1500);
  check('retouche ciblée d’une puce', (await page.locator('textarea[aria-label^="Point 1"]').first().inputValue()).startsWith('Conçu des interfaces'));
  await page.getByRole('tab', { name: 'Code LaTeX' }).click();
  await page.waitForTimeout(300);
  const tex = await page.getByLabel('Code source LaTeX du CV').inputValue();
  check('code LaTeX mis à jour sans IA', tex.includes('Titre modifié e2e') && tex.includes('Conçu des interfaces'));
  await page.getByRole('button', { name: /Compact/ }).first().click();
  await page.waitForTimeout(1200);
  check('changement de modèle sans perdre le contenu', (await page.getByLabel('Code source LaTeX du CV').inputValue()).includes('10pt') && (await page.getByLabel('Code source LaTeX du CV').inputValue()).includes('Titre modifié e2e'));
  await page.getByRole('button', { name: 'Créatif', exact: true }).click();
  await page.waitForTimeout(1200);
  const creatif = await page.getByLabel('Code source LaTeX du CV').inputValue();
  check('modèle Créatif : bandeau, pastilles, photo du profil', creatif.includes('\\fill[primary]') && creatif.includes('\\chip{') && creatif.includes('photo.jpg') && creatif.includes('Titre modifié e2e'));
  await page.getByRole('tab', { name: 'Lettre de motivation' }).click();
  const [letterTex] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Lettre .tex' }).click()]);
  const letterCode = fs.readFileSync(await letterTex.path(), 'utf8');
  check('lettre mise en page (expéditeur, objet, signature)', /Objet : Candidature/.test(letterCode) && /Karim Dupont/.test(letterCode) && /fill\[primary\]/.test(letterCode));
  if (await page.getByRole('button', { name: 'Lettre en PDF' }).count()) {
    const [letterPdf] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: 'Lettre en PDF' }).click()]);
    check('lettre en PDF', fs.readFileSync(await letterPdf.path()).subarray(0, 4).toString() === '%PDF');
  }
  await page.getByRole('tab', { name: 'Code LaTeX' }).click();
  if (/pdflatex|tectonic/.test(serverLog) || await page.getByRole('tab', { name: 'Aperçu' }).count()) {
    await page.getByRole('tab', { name: 'Aperçu' }).click();
    await page.waitForSelector('iframe[title="Aperçu du CV (PDF)"]', { timeout: 30000 }).catch(() => null);
    check('aperçu PDF intégré', (await page.locator('iframe[title="Aperçu du CV (PDF)"]').count()) === 1);
  }
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('button', { name: /PDF/ }).first().click()
  ]).catch(() => [null]);
  const pdfOk = dl ? fs.readFileSync(await dl.path()).subarray(0, 4).toString() === '%PDF' : false;
  check('PDF compilé (si LaTeX installé sur la machine)', pdfOk || !/pdflatex|tectonic/.test(serverLog), dl ? '' : 'aucun téléchargement');
  await page.getByRole('button', { name: 'Valider et postuler' }).click();
  await page.waitForTimeout(800);
  body = await page.textContent('body');
  check('version précédente archivée', /2 versions/.test(body));
  await page.getByRole('button', { name: /Voir le CV et la lettre/ }).first().click();
  await page.waitForTimeout(600);
  check('onglet Historique du studio', await page.getByRole('tab', { name: /Historique \(1\)/ }).isVisible());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Échap ferme la fenêtre', (await page.getByRole('dialog').count()) === 0);

  // Envoi, relance, rappel calendrier
  await page.getByRole('button', { name: /J’ai postulé/ }).first().click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /Préparer une relance/ }).first().click();
  await page.waitForTimeout(800);
  const [ics] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Ajouter un rappel au calendrier/ }).click()]);
  const icsText = fs.readFileSync(await ics.path(), 'utf8');
  check('rappel .ics (Outlook / Google Agenda)', icsText.startsWith('BEGIN:VCALENDAR') && icsText.includes('BEGIN:VEVENT'));
  await page.keyboard.press('Escape');

  // Statistiques + export
  await page.getByRole('tab', { name: /Statistiques/ }).click();
  body = await page.textContent('body');
  check('statistiques (taux de réponse, sources)', body.includes('Taux de réponse') && body.includes('Efficacité par source'));
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Exporter \(Excel\)/ }).click()]);
  const csvText = fs.readFileSync(await csv.path(), 'utf8');
  check('export CSV compatible Excel', csvText.includes('Entreprise;Poste') && csvText.split('\n').length === 3);

  // Persistance après rechargement
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  body = await page.textContent('body');
  check('persistance après rechargement (onglet + candidatures)', /Suivies\s*2/.test(body));

  // Thème sombre
  for (let i = 0; i < 3 && !(await page.evaluate(() => document.documentElement.classList.contains('dark'))); i++) {
    await page.getByRole('button', { name: /^Thème/ }).click();
  }
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('mode sombre', await page.evaluate(() => document.documentElement.classList.contains('dark')) && bg !== 'rgb(246, 247, 249)', bg);

  check('aucune erreur JavaScript', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();

  // --- Mobile -----------------------------------------------------------------------------------------
  console.log('\nMobile');
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await m.newPage();
  await mp.goto(`${BASE}/?q=d%C3%A9veloppeur&lieu=Avignon&offre=ft-201ABC`, { waitUntil: 'domcontentloaded' });
  await mp.waitForTimeout(1500);
  check('lien partagé : la fiche s’ouvre directement', await mp.getByRole('dialog', { name: /Développeur Python/ }).isVisible());
  await mp.getByRole('button', { name: /Retour aux offres/ }).click();
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('pas de défilement horizontal', overflow <= 1, `${overflow}px`);
  await m.close();
} catch (e) {
  check('exécution sans exception', false, e?.message);
} finally {
  await browser.close();
  stopAll();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} vérifications réussies.`);
process.exit(failed ? 1 : 0);
