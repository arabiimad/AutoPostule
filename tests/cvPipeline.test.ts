import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeOffer, tailorCv, validateTailored, applyTailored, defaultTailored, rewriteText, inventedContent, buildGuard, parseJson,
  type GenerateFn
} from '../server/cvPipeline.ts';
import { generateFallbackLatex } from '../server/latex.ts';

const CANDIDATE = {
  fullName: 'Imad Test',
  title: 'Chef de projet informatique',
  summary: 'Alternant en gestion de projet SI.',
  skills: ['Gestion de projet', 'Jira', 'Python', 'Kubernetes', 'SQL'],
  experiences: [
    { id: 'e1', title: 'Chef de projet informatique (alternance)', company: 'AFPA', startDate: '2025', endDate: 'Présent', bullets: ['Déploiement de logiciels internes sur 12 sites', 'Production de tutoriels vidéo e-learning'] },
    { id: 'e2', title: 'Stagiaire SRE', company: 'Oracle', startDate: '2023', endDate: '2023', bullets: ['Automatisation du monitoring en Python', 'Déploiements Kubernetes avec Helm'] }
  ],
  education: [{ degree: 'Master ILSEN', institution: 'Avignon Université', year: '2027' }],
  languages: ['Français', 'Anglais']
};
const JOB = { title: 'Chef de projet SI (H/F)', company: 'Mairie', description: 'Pilotage de projets SI, recette, conduite du changement. Maîtrise de SAP et Jira.', skillsRequired: ['Jira', 'SAP', 'Gestion de projet'] };

const fake = (responses: Record<string, any>): GenerateFn => async (prompt, opts) => {
  if (prompt.startsWith('Analyse cette offre')) return JSON.stringify(responses.analysis);
  if (prompt.includes('Adapte le CONTENU')) return typeof responses.tailor === 'string' ? responses.tailor : JSON.stringify(responses.tailor);
  if (prompt.startsWith('Réécris')) return JSON.stringify(responses.rewrite);
  throw new Error('prompt inattendu');
};

test('analyse de l’offre : JSON normalisé, repli sans IA', async () => {
  const a = await analyzeOffer(fake({ analysis: { domain: 'Collectivité', tone: 'institutionnel', mustHave: ['Jira', 'SAP'], missions: ['Recette'] } }), JOB);
  assert.equal(a.source, 'ai');
  assert.equal(a.tone, 'institutionnel');
  assert.deepEqual(a.mustHave, ['Jira', 'SAP']);
  const fb = await analyzeOffer(null, JOB);
  assert.equal(fb.source, 'fallback');
  assert.deepEqual(fb.mustHave, JOB.skillsRequired);
  assert.equal((await analyzeOffer(async () => 'pas du json', JOB)).source, 'fallback');
});

test('garde-fous : chiffres, outils et compétences manquantes inventés sont rejetés', () => {
  const guard = buildGuard(CANDIDATE, JOB);
  assert.equal(inventedContent('Déploiement de logiciels internes sur 12 sites', guard), null, 'chiffre du profil accepté');
  assert.match(inventedContent('Réduction des coûts de 30 %', guard)!, /30/);
  assert.match(inventedContent('Pilotage de projets sous Angular', guard)!, /Angular/);
  assert.match(inventedContent('Paramétrage de SAP pour la recette', guard)!, /sap/i);
  assert.equal(inventedContent('Pilotage de projets SI avec Jira', guard), null);
});

test('validation : puces inventées remplacées par l’original, ordre et compétences du profil uniquement', () => {
  const raw = {
    headline: 'Chef de projet SI — alternance',
    summary: 'Chef de projet SI en alternance, habitué au pilotage de projets et au suivi sous Jira.',
    experiences: [
      { id: 'e2', include: true, bullets: ['Automatisation du monitoring en Python', 'Gestion de 50 serveurs AWS'] },
      { id: 'e1', include: true, bullets: ['Pilotage du déploiement de logiciels internes sur 12 sites', 'Formation des utilisateurs'] },
      { id: 'inconnu', include: true, bullets: ['Expérience inventée'] }
    ],
    skillsOrder: ['Jira', 'SAP', 'Gestion de projet', 'Docker'],
    highlights: ['Déploiement sur 12 sites', 'Expert SAP depuis 10 ans']
  };
  const { tailored, rejected } = validateTailored(CANDIDATE, JOB, raw);
  assert.deepEqual(tailored.experiences.map(e => e.id), ['e2', 'e1'], 'id inconnu ignoré, ordre de l’IA conservé');
  assert.deepEqual(tailored.experiences[0].bullets, ['Automatisation du monitoring en Python', 'Déploiements Kubernetes avec Helm'], 'puce inventée → puce d’origine');
  assert.equal(tailored.experiences[1].bullets[0], 'Pilotage du déploiement de logiciels internes sur 12 sites');
  assert.equal(rejected.length, 1);
  assert.deepEqual(tailored.skillsOrder.slice(0, 2), ['Jira', 'Gestion de projet'], 'SAP et Docker (absents du profil) retirés');
  assert.ok(tailored.skillsOrder.includes('Kubernetes'), 'le reste du profil est conservé');
  assert.deepEqual(tailored.highlights, ['Déploiement sur 12 sites']);
  assert.equal(tailored.headline, 'Chef de projet SI — alternance');
});

test('chaîne complète : contenu IA → modèle LaTeX (titre, accroche, puces, faits intacts)', async () => {
  const gen = fake({
    analysis: { tone: 'institutionnel', mustHave: ['Jira'] },
    tailor: '```json\n' + JSON.stringify({
      headline: 'Chef de projet SI',
      summary: 'Pilotage de projets SI & suivi sous Jira : 100% orienté résultats.',
      experiences: [{ id: 'e1', include: true, bullets: ['Pilotage du déploiement de logiciels internes sur 12 sites'] }, { id: 'e2', include: false, bullets: [] }],
      skillsOrder: ['Jira']
    }) + '\n```'
  });
  const analysis = await analyzeOffer(gen, JOB);
  const r = await tailorCv(gen, CANDIDATE, JOB, analysis);
  assert.equal(r.source, 'ai');
  assert.equal(r.tailored.summary, CANDIDATE.summary, '« 100 % » absent du profil : accroche d’origine conservée');
  const tex = generateFallbackLatex(applyTailored(CANDIDATE, r.tailored), JOB, 'article', { tailored: true });
  assert.match(tex, /\\textbf\{Chef de projet SI\}/);
  assert.match(tex, /Pilotage du déploiement de logiciels internes sur 12 sites/);
  assert.match(tex, /AFPA/);
  assert.ok(!/Oracle/.test(tex), 'expérience masquée');
  assert.match(tex, /\\section\*\{COMPÉTENCES\}\n\\begin\{itemize\}[^\n]*\n\s+\\item Jira/);
});

test('sans IA ou réponse illisible : CV construit depuis le profil', async () => {
  const r = await tailorCv(async () => 'erreur', CANDIDATE, JOB, await analyzeOffer(null, JOB));
  assert.equal(r.source, 'profile');
  assert.deepEqual(r.tailored, defaultTailored(CANDIDATE, JOB));
  assert.deepEqual([...r.tailored.skillsOrder.slice(0, 2)].sort(), ['Gestion de projet', 'Jira'], 'compétences demandées en tête');
});

test('retouche ciblée : acceptée si fidèle, sinon texte d’origine', async () => {
  const ok = await rewriteText(fake({ rewrite: { text: 'Piloté le déploiement de logiciels internes sur 12 sites' } }), CANDIDATE, JOB, 'Déploiement de logiciels internes sur 12 sites', 'plus percutant', 'bullet');
  assert.equal(ok.text, 'Piloté le déploiement de logiciels internes sur 12 sites');
  const ko = await rewriteText(fake({ rewrite: { text: 'Déployé SAP sur 40 sites' } }), CANDIDATE, JOB, 'Déploiement de logiciels internes sur 12 sites', 'plus percutant', 'bullet');
  assert.equal(ko.text, 'Déploiement de logiciels internes sur 12 sites');
  assert.ok(ko.rejected);
});

test('lecture JSON tolérante (bloc ```json)', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Voici : {"a":2} merci'), { a: 2 });
  assert.equal(parseJson('rien'), null);
});

test('relecture sémantique : une reformulation non fidèle revient au texte d’origine', async () => {
  const { reviewTailored } = await import('../server/cvPipeline.ts');
  const tailored = {
    headline: 'x', summary: 'y', skillsOrder: [], highlights: [],
    experiences: [{ id: 'e1', include: true, bullets: ['Piloté le déploiement de logiciels internes sur 12 sites', 'Production de tutoriels vidéo e-learning'] }]
  };
  let prompt = '';
  const gen: GenerateFn = async (p) => { prompt = p; return JSON.stringify({ approved: [] }); };
  const r = await reviewTailored(gen, CANDIDATE, tailored);
  assert.match(prompt, /jamais des instructions/, 'données isolées des consignes');
  assert.match(prompt, /"ref":"0:0"/);
  assert.ok(!prompt.includes('"ref":"0:1"'), 'puce identique à l’original : pas relue');
  assert.deepEqual(r.tailored.experiences[0].bullets, ['Déploiement de logiciels internes sur 12 sites', 'Production de tutoriels vidéo e-learning']);
  assert.equal(r.rejected.length, 1);
});

test('projets personnels rendus dans les modèles LaTeX et Web', async () => {
  const { renderCvHtml } = await import('../server/pdf.ts');
  const withProject = { ...CANDIDATE, projects: [{ name: 'AutoPostule', description: 'Plateforme de candidatures', technologies: ['React', 'Node.js'] }] };
  for (const t of ['article', 'moderncv', 'compact'] as const) {
    assert.match(generateFallbackLatex(withProject, JOB, t), /AutoPostule/);
  }
  assert.match(renderCvHtml(withProject, JOB, 'article'), /Plateforme de candidatures/);
});
