import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeLatex, escapeLatexUrl, generateFallbackLatex, compileLatex, detectLatexCompiler } from '../server/latex.ts';

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

for (const template of ['article', 'moderncv', 'compact'] as const) {
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

test('compilation réelle des 3 modèles (si un compilateur est installé)', async (t) => {
  if (!(await detectLatexCompiler())) return t.skip('aucun compilateur LaTeX');
  for (const template of ['article', 'moderncv', 'compact'] as const) {
    const r = await compileLatex(generateFallbackLatex(candidate, job, template));
    assert.ok(r.pdf && r.pdf.subarray(0, 4).toString() === '%PDF', `${template}: ${r.error}`);
  }
});
