/**
 * Corpus de CV de métiers variés (tests/fixtures/cv-corpus) : l'analyseur local repère l'essentiel
 * et n'invente rien (chaque compétence, entreprise et diplôme figure dans le texte du CV).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseCvSemantically } from '../src/semanticCvParser.ts';

const dir = path.join(import.meta.dirname, 'fixtures', 'cv-corpus');
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ');

for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.txt'))) {
  test(`corpus : ${file.replace('.txt', '')}`, () => {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const t = fold(text);
    const p = parseCvSemantically(text);
    const [firstLine] = text.split('\n');
    assert.equal(p.fullName, firstLine.trim(), 'nom');
    assert.match(p.email, /@mail\.fr$/, 'e-mail');
    assert.ok(p.phone, 'téléphone');
    assert.ok(p.experiences.length >= 2, `${p.experiences.length} expérience(s)`);
    for (const e of p.experiences) {
      assert.ok(e.company && t.includes(fold(e.company)), `entreprise « ${e.company} » présente dans le texte`);
      assert.ok(e.title && e.title !== 'Poste', 'intitulé');
      assert.ok(e.startDate, 'date de début');
    }
    assert.ok(p.skills.length >= 3, `${p.skills.length} compétence(s)`);
    for (const s of p.skills) assert.ok(t.includes(fold(s)), `compétence « ${s} » inventée`);
    assert.ok(p.education.length >= 1, 'formation');
    for (const e of p.education) assert.ok(t.includes(fold(e.degree).slice(0, 12)), `diplôme « ${e.degree} » présent dans le texte`);
  });
}
