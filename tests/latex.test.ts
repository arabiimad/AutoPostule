import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { escapeLatex, escapeLatexUrl, generateFallbackLatex, generateLetterLatex, letterParagraphs, compileLatex, detectLatexCompiler, decodeJpegPhoto, withoutPhoto, PHOTO_FILE } from '../server/latex.ts';
import { buildGuard } from '../server/cvPipeline.ts';
import { CV_TEMPLATE_IDS, normalizeCvTemplate } from '../src/utils/templates.ts';

const candidate = {
  fullName: 'Sarah Benali',
  email: 's@b.fr',
  skills: ['Canva', 'SEO'],
  experiences: [{ title: 'Chargée com', company: 'Lumen & Co', startDate: '2022', current: true, bullets: ['Budget 5k$ C:\\temp', 'Pilotage : 3 prestataires'] }]
};
const job = { title: 'Chargé de com', company: 'Acme', skillsRequired: ['Canva', 'Pack Office'] };

test('échappement LaTeX en une seule passe', () => {
  assert.equal(escapeLatex('a\\b'), 'a\\textbackslash{}b');
  assert.equal(escapeLatex('50% & 5$ #1 _x_ {y}'), '50\\% \\& 5\\$ \\#1 \\_x\\_ \\{y\\}');
  assert.equal(escapeLatexUrl('https://x.fr/a%20b#c'), 'https://x.fr/a\\%20b\\#c');
});

for (const template of CV_TEMPLATE_IDS) {
  test(`modèle ${template} : uniquement les données du profil`, () => {
    const tex = generateFallbackLatex(candidate, job, template);
    assert.match(tex, /Sarah/);
    assert.match(tex, /Lumen \\& Co/);
    assert.doesNotMatch(tex, /Permis|ILSEN|Imadeddine|Certification|Pack Office|FORMATIONS|Formations|LANGUES|Langues/);
    assert.match(tex, /\\begin\{document\}[\s\S]*\\end\{document\}/);
  });
}

test('compilation : commandes shell / fichiers refusées', async () => {
  const r = await compileLatex('\\documentclass{article}\\begin{document}\\immediate\\write18{rm -rf /}\\end{document}');
  assert.ok(r.error);
  assert.ok(!r.pdf);
});

// Plus petit JPEG reconnaissable (en-tête SOI + APP0) : suffit aux contrôles, pas à la compilation
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const withPhoto = { ...candidate, photo: `data:image/jpeg;base64,${TINY_JPEG.toString('base64')}` };

test('modèles : liste partagée et valeur inconnue ramenée au Classique', () => {
  assert.deepEqual(CV_TEMPLATE_IDS, ['article', 'photo', 'creatif', 'moderncv', 'compact']);
  assert.equal(normalizeCvTemplate('creatif'), 'creatif');
  assert.equal(normalizeCvTemplate('canva'), 'article');
});

test('photo : affichée seulement par les modèles Photo et Créatif, et seulement si le profil en a une', () => {
  for (const template of ['photo', 'creatif'] as const) {
    assert.match(generateFallbackLatex(withPhoto, job, template), new RegExp(`\\\\IfFileExists\\{${PHOTO_FILE.replace('.', '\\.')}\\}`));
    assert.doesNotMatch(generateFallbackLatex(candidate, job, template), /includegraphics/);
  }
  for (const template of ['article', 'moderncv', 'compact'] as const) {
    assert.doesNotMatch(generateFallbackLatex(withPhoto, job, template), /includegraphics/);
  }
  // Le serveur ne reçoit que l'indicateur : la mise en page reste la même
  assert.match(generateFallbackLatex(withoutPhoto(withPhoto), job, 'creatif'), /includegraphics/);
});

test('photo : jamais transmise à l\'IA ni aux garde-fous', () => {
  const stripped: any = withoutPhoto(withPhoto);
  assert.equal(stripped.photo, undefined);
  assert.equal(stripped.hasPhoto, true);
  assert.equal((withoutPhoto({ ...candidate, photo: '' }) as any).hasPhoto, false);
  assert.equal(withoutPhoto(candidate), candidate);
  // Les chiffres du base64 ne doivent pas devenir des « chiffres autorisés »
  const big: any = withoutPhoto({ ...candidate, photo: `data:image/jpeg;base64,${Buffer.alloc(3000, 7).toString('base64')}987654` });
  assert.ok(!buildGuard(big, job).numbers.has('987654'));
});

test('photo : seul un JPEG raisonnable est accepté à la compilation', () => {
  assert.ok(decodeJpegPhoto(withPhoto.photo));
  assert.ok(decodeJpegPhoto(TINY_JPEG.toString('base64')));
  assert.equal(decodeJpegPhoto('data:image/png;base64,iVBORw0KGgo='), null);
  assert.equal(decodeJpegPhoto(Buffer.from('%PDF-1.4 pas une image').toString('base64')), null);
  assert.equal(decodeJpegPhoto(`data:image/jpeg;base64,${Buffer.concat([TINY_JPEG, Buffer.alloc(700_000)]).toString('base64')}`), null);
  assert.equal(decodeJpegPhoto(undefined), null);
});

test('modèle Créatif : bandeau, pastilles de compétences, une seule colonne, texte extractible', () => {
  const tex = generateFallbackLatex(candidate, job, 'creatif');
  assert.match(tex, /\\fill\[primary\]/);
  assert.match(tex, /\\chip\{Canva\}/);
  assert.match(tex, /\\pdfgentounicode=1/);
  assert.match(tex, /\\DisableLigatures/);
  assert.doesNotMatch(tex, /multicol|paracol|\\begin\{tabular/);
});

const letter = `Madame, Monsieur,

Chargée de communication chez Lumen & Co, je pilote 3 prestataires.

Je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées.

Sarah Benali`;

test('lettre : paragraphes sans la signature (ajoutée par le modèle)', () => {
  const paras = letterParagraphs(letter, 'Sarah Benali');
  assert.equal(paras.length, 3);
  assert.equal(paras[0], 'Madame, Monsieur,');
  assert.deepEqual(letterParagraphs('Bonjour,\n\nCordialement,\nSARAH BENALI', 'Sarah Benali'), ['Bonjour,', 'Cordialement,']);
});

test('lettre : expéditeur, destinataire, objet, corps échappé, signature', () => {
  const tex = generateLetterLatex({ ...candidate, location: 'Lyon (69)', phone: '06 11 22 33 44' }, { ...job, location: 'Paris' }, letter, 'article', new Date('2026-09-24T12:00:00Z'));
  assert.match(tex, /\\textbf\{\\textcolor\{primary\}\{Sarah Benali/);
  assert.match(tex, /06 11 22 33 44/);
  assert.match(tex, /À l'attention du service Recrutement\}\\\\\n\\textbf\{Acme\}\\\\\nParis/);
  assert.match(tex, /Lyon, le 24 septembre 2026/);
  assert.match(tex, /Objet : Candidature au poste de Chargé de com/);
  assert.match(tex, /Lumen \\& Co/);
  assert.equal((tex.match(/Sarah Benali/g) || []).length, 2, 'nom : en-tête + signature, pas de doublon');
  assert.match(tex, /\\begin\{document\}[\s\S]*\\end\{document\}/);
  const spontaneous = generateLetterLatex(candidate, { company: 'Acme', title: 'Candidature spontanée — Graphiste', isSpontaneous: true }, letter, 'creatif');
  assert.match(spontaneous, /Objet : Candidature spontanée -- Graphiste/);
  assert.match(spontaneous, /\\fill\[primary\]/);
});

test('compilation réelle des modèles et des lettres (si un compilateur est installé)', async (t) => {
  if (!(await detectLatexCompiler())) return t.skip('aucun compilateur LaTeX');
  const full = { ...candidate, summary: 'Profil orienté planification et efficacité', education: [{ degree: 'Master', institution: 'Université', year: '2024' }], languages: ['Anglais (B2)'], projects: [{ name: 'Site', description: 'Refonte', technologies: ['WordPress'] }] };
  for (const template of CV_TEMPLATE_IDS) {
    const r = await compileLatex(generateFallbackLatex(full, job, template));
    assert.ok(r.pdf && r.pdf.subarray(0, 4).toString() === '%PDF', `${template}: ${r.error}`);
    const l = await compileLatex(generateLetterLatex(full, job, letter, template));
    assert.ok(l.pdf && l.pdf.subarray(0, 4).toString() === '%PDF', `lettre ${template}: ${l.error}`);
  }
});

test('ATS : le texte du PDF Créatif est extractible dans l\'ordre, sans ligatures (si pdftotext est installé)', async (t) => {
  if (!(await detectLatexCompiler())) return t.skip('aucun compilateur LaTeX');
  if (spawnSync('pdftotext', ['-v']).error) return t.skip('pdftotext absent');
  const full = { ...candidate, summary: 'Profil orienté planification et efficacité' };
  const r = await compileLatex(generateFallbackLatex(full, job, 'creatif'));
  assert.ok(r.pdf, r.error);
  const text = spawnSync('pdftotext', ['-', '-'], { input: r.pdf }).stdout.toString();
  assert.match(text, /planification et efficacité/);
  const order = ['Sarah Benali', 'PROFIL', 'EXPÉRIENCES', 'Chargée com', 'COMPÉTENCES', 'Canva'].map((k) => text.indexOf(k));
  assert.ok(order.every((i) => i >= 0), `texte extrait : ${text.slice(0, 300)}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'ordre de lecture');
});
