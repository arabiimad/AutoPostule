import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCvForAts, findSections, matchCvToOffer, offerKeywords, offerPhrases, repairDetachedAccents, countPdfPages } from '../server/atsCheck.ts';
import fs from 'node:fs';
import { readCvInput, readOfferInput } from '../server/routes/tools.ts';

const goodCv = `Nadia Benali
Aide-soignante
nadia.benali@mail.fr | 06 12 34 56 78 | Lyon

PROFIL
Aide-soignante diplômée, cinq ans d'expérience en EHPAD et en service de médecine, attentive au confort et à la dignité des résidents.

EXPÉRIENCES PROFESSIONNELLES
Aide-soignante — EHPAD Les Tilleuls, Lyon | 03/2020 – aujourd'hui
• Soins d'hygiène et de confort auprès des résidents
• Transmissions écrites et orales à l'équipe soignante
• Aide à la prise des repas et accompagnement à la mobilité
• Participation aux projets d'animation de l'établissement
Agent de service hospitalier — Hôpital Nord, Lyon | 09/2018 – 02/2020
• Entretien des chambres et des locaux selon les protocoles d'hygiène
• Distribution des repas et collaboration avec l'équipe soignante

FORMATIONS
2019 : Diplôme d'État d'aide-soignant (DEAS) - IFAS Lyon
2017 : Baccalauréat ST2S - Lycée Ampère, Lyon

COMPÉTENCES
Soins d'hygiène, Travail en équipe, Transmissions, Excel, Word, Communication, Rigueur, Bienveillance

LANGUES
Français (natif), Anglais (B1)`;

test('ATS : CV propre, sections usuelles → bon score, aucun échec', () => {
  const r = analyzeCvForAts(goodCv, { format: 'text' });
  assert.ok(r.score >= 85, `score ${r.score}`);
  assert.equal(r.level, 'excellent');
  assert.ok(r.checks.every((c) => c.status !== 'fail'), JSON.stringify(r.checks.filter((c) => c.status !== 'ok')));
  assert.deepEqual(r.stats.sections, ['Expérience', 'Formation', 'Compétences', 'Langues', 'Profil']);
  assert.ok(r.preview.startsWith('Nadia Benali'));
});

test('ATS : CV scanné (presque sans texte) → échec explicite et score plafonné', () => {
  const r = analyzeCvForAts('Nadia', { format: 'pdf', pages: 1 });
  const text = r.checks.find((c) => c.id === 'text')!;
  assert.equal(text.status, 'fail');
  assert.match(text.advice || '', /scanné|image/);
  assert.ok(r.score <= 15);
  assert.equal(r.level, 'insuffisant');
});

test('ATS : accents détachés (PDF LaTeX sans T1) signalés, sections quand même reconnues', () => {
  const broken = goodCv.replace(/é/g, '´e').replace(/è/g, '`e');
  const r = analyzeCvForAts(broken, { format: 'pdf', pages: 1 });
  const chars = r.checks.find((c) => c.id === 'characters')!;
  assert.equal(chars.status, 'fail');
  assert.match(chars.detail, /deux signes/);
  assert.match(chars.advice || '', /fontenc/);
  assert.ok(r.score <= 60, `score ${r.score}`);
  assert.ok(r.stats.sections.includes('Expérience'));
  assert.equal(repairDetachedAccents('D´eveloppeur Exp´eriences Syst`emes'), 'Développeur Expériences Systèmes');
});

test('ATS : ligatures, icônes, coordonnées et sections manquantes', () => {
  const r = analyzeCvForAts('Jean Dupont\nMes super pouvoirs\nplaniﬁcation  \n' + 'mot '.repeat(200), { format: 'pdf' });
  assert.equal(r.checks.find((c) => c.id === 'characters')!.status, 'warn');
  assert.equal(r.checks.find((c) => c.id === 'contact')!.status, 'fail');
  assert.equal(r.checks.find((c) => c.id === 'sections')!.status, 'fail');
});

test('ATS : longueur et nombre de pages', () => {
  const long = analyzeCvForAts(goodCv, { format: 'pdf', pages: 4 });
  assert.equal(long.checks.find((c) => c.id === 'length')!.status, 'warn');
  assert.equal(countPdfPages(Buffer.from('%PDF-1.4 /Type /Page /Type /Pages /Type/Page')), 2);
  assert.equal(countPdfPages(Buffer.from('rien')), null);
  assert.deepEqual(findSections('Mon parcours professionnel\nÉtudes\nSavoir-faire'), ['Expérience', 'Formation', 'Compétences']);
});

const nurseOffer = `Aide-soignant(e) H/F - CDI
Missions : soins d'hygiène et de confort, transmissions écrites, travail en équipe pluridisciplinaire.
Profil : DEAS obligatoire, AFGSU souhaitée, maîtrise du logiciel NetSoins, Permis B.
Vous rejoindrez une équipe bienveillante au sein de notre établissement.`;

test('match : mots-clés de l\'offre pour un métier non technique (expressions, sigles, permis)', () => {
  const k = offerKeywords(nurseOffer);
  for (const expected of ['DEAS', 'AFGSU', "soins d'hygiène et de confort", 'transmissions écrites', 'logiciel NetSoins', 'Permis B']) {
    assert.ok(k.includes(expected), `${expected} absent de ${JSON.stringify(k)}`);
  }
  // Ni doublon (« AFGSU souhaitée »), ni mot générique, ni phrase rédigée
  assert.ok(!k.some((w) => /souhait|obligatoire|CDI|H\/F|^H$|^F$|rejoindrez/i.test(w)), JSON.stringify(k));
});

test('match : expressions nettoyées (élision, H/F, noms d\'action)', () => {
  assert.deepEqual(offerPhrases('Missions : développement d’interfaces React, l’accueil des clients, gestion de la paie.'), ['interfaces React', 'accueil des clients', 'paie']);
  assert.ok(!offerKeywords('Comptable H/F (CDI)\nSaisie comptable, rapprochements bancaires, logiciel Sage.').some((k) => /H\/F|^CDI$/.test(k)));
});

test('match : présents et absents, score = part des mots-clés couverts', () => {
  const m = matchCvToOffer(goodCv, nurseOffer);
  for (const k of ['DEAS', "soins d'hygiène et de confort", 'transmissions écrites', 'travail en équipe pluridisciplinaire']) assert.ok(m.matched.includes(k), `${k} devrait être présent`);
  for (const k of ['AFGSU', 'logiciel NetSoins', 'Permis B']) assert.ok(m.missing.includes(k), `${k} devrait manquer`);
  assert.equal(m.score, Math.round((m.matched.length / m.keywords.length) * 100));
  assert.equal(matchCvToOffer(goodCv, '').score, null);
});

test('outils : lecture du CV (texte collé, format refusé, fichier trop lourd)', async () => {
  const pasted: any = await readCvInput({ cvText: goodCv });
  assert.equal(pasted.meta.format, 'text');
  assert.equal(((await readCvInput({})) as any).status, 400);
  assert.equal(((await readCvInput({ fileBase64: Buffer.from('GIF89a').toString('base64'), mimeType: 'image/gif' })) as any).status, 415);
  assert.equal(((await readCvInput({ fileBase64: Buffer.alloc(9 * 1024 * 1024).toString('base64'), mimeType: 'application/pdf' })) as any).status, 413);
});

test('outils : offre déposée en document (PDF, texte) ou collée', async () => {
  const pdf: any = await readOfferInput({ offerFileBase64: fs.readFileSync(new URL('./fixtures/offre-exemple.pdf', import.meta.url)).toString('base64'), offerMimeType: 'application/pdf', offerFileName: 'offre.pdf' });
  assert.equal(pdf.meta.format, 'pdf');
  assert.match(pdf.text, /Kubernetes/);
  assert.ok(offerKeywords(pdf.text).includes('Kubernetes'));
  const txt: any = await readOfferInput({ offerFileBase64: Buffer.from(nurseOffer, 'utf8').toString('base64'), offerMimeType: 'text/plain', offerFileName: 'offre.txt' });
  assert.equal(txt.text, nurseOffer);
  assert.equal(((await readOfferInput({ offerText: nurseOffer })) as any).meta.format, 'text');
  const missing: any = await readOfferInput({});
  assert.equal(missing.status, 400);
  assert.match(missing.error, /l'offre/);
  assert.equal(((await readOfferInput({ offerFileBase64: Buffer.from('GIF89a').toString('base64'), offerMimeType: 'image/gif', offerFileName: 'offre.gif' })) as any).status, 415);
});
