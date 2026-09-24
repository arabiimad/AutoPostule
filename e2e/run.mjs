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
const outDir = process.env.E2E_OUT_DIR || (await import('node:os')).tmpdir();
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

  const quotaRes = await (await fetch(`${BASE}/api/tailor/latex`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidate: cv.profile, job: { title: 'Poste QUOTA-E2E', company: 'Test', description: 'QUOTA-E2E', skillsRequired: [] } })
  })).json();
  check('quota IA épuisé : CV construit quand même, message clair sans détail technique',
    !!quotaRes.latexCode && /très sollicité/.test(quotaRes.notice || '') && !/[{}]|googleapis|RESOURCE_EXHAUSTED|429|gemini/i.test(quotaRes.notice || ''), quotaRes.notice);

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
  check('marque Kareer : écran de démarrage remplacé, logo et titre', (await page.locator('#boot').count()) === 0
    && await page.getByRole('button', { name: 'Kareer — accueil' }).isVisible() && /^Kareer/.test(await page.title()));
  check('premiers pas affichés au premier lancement', await page.getByText('Bienvenue sur Kareer').isVisible());

  // Import du CV (texte collé)
  await page.getByRole('button', { name: /Importer mon CV/ }).first().click();
  await page.getByRole('button', { name: 'Coller le texte' }).click();
  await page.getByLabel('Texte complet de votre CV').fill(`Karim Dupont\nDéveloppeur Full Stack\nkarim@mail.fr | 06 11 22 33 44\n12 rue de la République 84000 Avignon\nEXPÉRIENCES PROFESSIONNELLES\nDéveloppeur - Studio X | 2021 - Présent\nDéveloppement React et Node.js, API REST\nCOMPÉTENCES\nReact, TypeScript, Python, PostgreSQL, Git, Docker, Node.js, JavaScript`);
  await page.getByRole('button', { name: /Analyser mon CV/ }).click();
  await page.getByRole('button', { name: /Confirmer et enregistrer/ }).click({ timeout: 15000 });
  await page.getByRole('button', { name: /Voir les offres/ }).click();
  check('profil enregistré (premiers pas masqués)', !(await page.getByText('Bienvenue sur Kareer').isVisible()));

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
  // Glisser-déposer : un fichier refusé, puis la photo
  const dropFile = async (name, type, b64) => {
    const dt = await page.evaluateHandle(({ name, type, b64 }) => {
      const d = new DataTransfer();
      d.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type }));
      return d;
    }, { name, type, b64 });
    const zone = page.getByTestId('photo-dropzone');
    await zone.dispatchEvent('dragover', { dataTransfer: dt });
    await zone.dispatchEvent('drop', { dataTransfer: dt });
    await page.waitForTimeout(500);
  };
  await dropFile('cv.pdf', 'application/pdf', Buffer.from('%PDF-1.4').toString('base64'));
  check('glisser-déposer : format refusé expliqué', await page.getByText(/Format non pris en charge/).isVisible());
  await dropFile('photo.jpg', 'image/jpeg', fs.readFileSync(path.join(root, 'tests', 'fixtures', 'photo.jpg')).toString('base64'));
  check('glisser-déposer : photo ajoutée au profil', await page.getByAltText('Votre photo de CV').isVisible() && !(await page.getByText(/Format non pris en charge/).isVisible()));
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
  // Freemium : 2e retouche au-delà du quota gratuit → fenêtre « Passer à Premium »
  await page.getByRole('button', { name: 'Retoucher le point 1' }).first().click();
  await page.getByRole('button', { name: 'Plus concis' }).click();
  await page.waitForTimeout(1200);
  const upgrade = page.getByRole('dialog', { name: 'Limite du mois atteinte' });
  check('quota gratuit atteint : fenêtre « Passer à Premium »', await upgrade.isVisible().catch(() => false));
  await upgrade.getByRole('button', { name: 'Plus tard' }).click();
  await page.waitForTimeout(300);
  check('fenêtre Premium refermée', !(await upgrade.isVisible()));
  await page.getByRole('tab', { name: 'Code LaTeX' }).click();
  await page.waitForTimeout(300);
  const tex = await page.getByLabel('Code source LaTeX du CV').inputValue();
  check('code LaTeX mis à jour sans IA', tex.includes('Titre modifié e2e') && tex.includes('Conçu des interfaces'));
  await page.getByRole('button', { name: /Compact/ }).first().click();
  await page.waitForTimeout(1200);
  check('changement de modèle sans perdre le contenu', (await page.getByLabel('Code source LaTeX du CV').inputValue()).includes('10pt') && (await page.getByLabel('Code source LaTeX du CV').inputValue()).includes('Titre modifié e2e'));
  await page.getByRole('button', { name: 'Photo', exact: true }).click();
  await page.waitForTimeout(1200);
  const withPhotoTex = await page.getByLabel('Code source LaTeX du CV').inputValue();
  check('modèle Photo : photo du profil, formations d’abord', withPhotoTex.includes('photo.jpg') && withPhotoTex.includes('\\resumeSubheading') && withPhotoTex.includes('Titre modifié e2e'));
  await page.getByRole('tab', { name: 'Lettre de motivation' }).click();
  const [letterTex] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Lettre .tex' }).click()]);
  const letterCode = fs.readFileSync(await letterTex.path(), 'utf8');
  check('lettre mise en page (expéditeur, objet, signature)', /Objet : Candidature/.test(letterCode) && /Karim Dupont/.test(letterCode) && /l'équipe Recrutement/.test(letterCode));
  if (await page.getByRole('button', { name: 'Lettre en PDF' }).count()) {
    const [letterPdf] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: 'Lettre en PDF' }).click()]);
    check('lettre en PDF', fs.readFileSync(await letterPdf.path()).subarray(0, 4).toString() === '%PDF');
  }
  await page.getByRole('tab', { name: 'Code LaTeX' }).click();
  // Le modèle Photo passe en LaTeX si le serveur compile : retour au moteur Web pour l'aperçu Web
  await page.getByRole('button', { name: 'Web', exact: true }).click();
  await page.getByRole('tab', { name: 'Aperçu' }).click();
  await page.waitForSelector('iframe[title="Aperçu du CV"]', { timeout: 30000 }).catch(() => null);
  const webFrame = page.frameLocator('iframe[title="Aperçu du CV"]');
  const webText = await webFrame.locator('body').textContent({ timeout: 10000 }).catch(() => '');
  check('aperçu Web intégré (contenu adapté)', /Titre modifié e2e/.test(webText || ''), (webText || '').slice(0, 80));
  await page.screenshot({ path: path.join(outDir, 'studio-apercu-web.png') }).catch(() => null);
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('button', { name: /PDF/ }).first().click()
  ]).catch(() => [null]);
  const pdfOk = dl ? fs.readFileSync(await dl.path()).subarray(0, 4).toString() === '%PDF' : false;
  check('PDF Web téléchargé (Chromium)', pdfOk, dl ? '' : 'aucun téléchargement');
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

  await page.goto(`${BASE}/?onglet=tarifs`);
  await page.waitForTimeout(1200);
  const pricing = await page.textContent('main');
  check('page Tarifs : forfaits et consommation du mois', /Premium/.test(pricing) && /Retouches et évaluations IA\s*1\s*\/\s*1/.test(pricing), pricing.slice(0, 160));
  check('aucune erreur JavaScript', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();

  // --- Outils publics (sans compte) ------------------------------------------------------------------
  console.log('\nOutils publics');
  for (const [label, viewport] of [['bureau', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const tctx = await browser.newContext({ viewport, locale: 'fr-FR', ...(label === 'mobile' ? { isMobile: true, hasTouch: true } : {}) });
    const tp = await tctx.newPage();
    const jobCalls = [];
    tp.on('request', (r) => { if (r.url().includes('/api/jobs/search')) jobCalls.push(r.url()); });
    const toolErrors = [];
    tp.on('pageerror', (e) => toolErrors.push(e.message));
    await tp.goto(`${BASE}/verificateur-cv-ats`, { waitUntil: 'domcontentloaded' });
    await tp.waitForTimeout(800);
    check(`[${label}] vérificateur ATS : page publique, titre dédié`, /Vérificateur de CV ATS/.test(await tp.title()) && await tp.getByRole('heading', { name: /logiciels de recrutement/ }).isVisible());
    await tp.getByLabel('Choisir le fichier de votre CV').setInputFiles(path.join(root, 'tests', 'fixtures', 'cv-exemple.docx'));
    await tp.getByRole('button', { name: 'Analyser mon CV' }).click();
    await tp.getByRole('heading', { name: /Compatibilité ATS/ }).waitFor({ timeout: 15000 });
    const atsText = await tp.textContent('main');
    check(`[${label}] vérificateur ATS : score et contrôles détaillés`, /Coordonnées/.test(atsText) && /Sections standard/.test(atsText) && /\/ 100|sur 100/.test(await tp.locator('svg[role=img]').first().getAttribute('aria-label') || ''), atsText.slice(0, 120));
    await tp.getByRole('button', { name: /Comparer ce CV à une offre/ }).click();
    await tp.waitForTimeout(300);
    check(`[${label}] adresse partageable du comparateur`, new URL(tp.url()).pathname === '/match-cv-offre');
    // Offre : déposée en PDF sur bureau, collée en texte sur mobile
    if (label === 'bureau') {
      await tp.getByLabel('Choisir le fichier de l’offre').setInputFiles(path.join(root, 'tests', 'fixtures', 'offre-exemple.pdf'));
      check('[bureau] offre déposée en document (PDF)', await tp.getByText('offre-exemple.pdf').waitFor({ timeout: 5000 }).then(() => true, () => false));
    } else {
      await tp.getByRole('group', { name: /fournir l’offre/ }).getByRole('button', { name: 'Coller le texte' }).click();
      await tp.getByLabel('Texte de l’offre').fill('Développeur React H/F - CDI\nMissions : développement d’interfaces React, API REST en Node.js.\nProfil : TypeScript, Docker, Kubernetes souhaité.');
    }
    await tp.getByRole('button', { name: 'Comparer', exact: true }).click();
    await tp.getByRole('heading', { name: /présents dans votre CV/ }).waitFor({ timeout: 15000 });
    const matchText = await tp.textContent('main');
    check(`[${label}] comparaison CV / offre : présents et absents`, /React/.test(matchText) && /Absents de votre CV/.test(matchText) && /Kubernetes/.test(matchText), matchText.slice(0, 160));
    check(`[${label}] outils : aucune recherche d’offres lancée (quotas préservés)`, jobCalls.length === 0, jobCalls.join(' '));
    check(`[${label}] outils : pas de défilement horizontal, aucune erreur`, !(await tp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) && toolErrors.length === 0, toolErrors.join(' | '));
    await tp.screenshot({ path: path.join(outDir, `outils-${label}.png`), fullPage: true }).catch(() => null);
    await tctx.close();
  }

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
  for (const p of browser.contexts().flatMap((c) => c.pages()).slice(0, 1)) await p.screenshot({ path: path.join(outDir, 'e2e-echec.png') }).catch(() => {});
  check('exécution sans exception', false, e?.message);
} finally {
  await browser.close();
  stopAll();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} vérifications réussies.`);
process.exit(failed ? 1 : 0);
