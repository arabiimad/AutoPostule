import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCvSemantically, isParsedCvEmpty } from '../src/semanticCvParser.ts';

const CV = `Sarah Benali
Chargée de Communication
sarah.benali@mail.fr | 06 12 34 56 78
12 rue des Lilas 84000 Avignon
PROFIL
Communicante bilingue, 3 ans d'expérience en agence.
EXPÉRIENCES PROFESSIONNELLES
Chargée de communication - Agence Lumen | 2022 - Présent
Gestion des réseaux sociaux, +40% d'abonnés sur 15000 utilisateurs
Stage communication chez Mairie d'Arles 2021 - 2022
Rédaction de communiqués de presse
FORMATION & CERTIFICATIONS
Master Communication | Université d'Avignon | 2020 - 2022
COMPÉTENCES
Canva, Adobe InDesign, Rédaction web, SEO
LANGUES
Anglais C1, Espagnol B1`;

test('extraction fidèle des coordonnées et du lieu', () => {
  const p = parseCvSemantically(CV);
  assert.equal(p.fullName, 'Sarah Benali');
  assert.equal(p.email, 'sarah.benali@mail.fr');
  assert.equal(p.phone, '06 12 34 56 78');
  assert.equal(p.location, 'Avignon (84)');
});

test('expériences : poste / entreprise / dates, et « Stage … chez … » n\'est pas un titre de section', () => {
  const p = parseCvSemantically(CV);
  assert.equal(p.experiences.length, 2);
  assert.deepEqual([p.experiences[0].title, p.experiences[0].company, p.experiences[0].endDate], ['Chargée de communication', 'Agence Lumen', 'Présent']);
  assert.deepEqual([p.experiences[1].title, p.experiences[1].company], ['Stage communication', "Mairie d'Arles"]);
});

test('chaque langue garde son propre niveau', () => {
  assert.deepEqual(parseCvSemantically(CV).languages, ['Anglais (C1)', 'Espagnol (B1)']);
});

test('rien n\'est inventé sur un texte illisible', () => {
  const p = parseCvSemantically('PK\u0003\u0004 contenu binaire 2021 2022 2023');
  assert.equal(p.fullName, '');
  assert.equal(p.summary, '');
  assert.deepEqual(p.skills, []);
  assert.deepEqual(p.education, []);
  assert.deepEqual(p.languages, []);
  assert.equal(isParsedCvEmpty(p), true);
});

test('compétences du profil : telles qu’écrites, sans regroupement ni ajout (pas de « Kubernetes » pour « Docker »)', () => {
  const cv = parseCvSemantically(`Karim Dupont\nDéveloppeur\nkarim@mail.fr\nCOMPÉTENCES\nReact, PostgreSQL, Git, Docker, Node.js`);
  assert.deepEqual(cv.skills.filter((s) => /docker|kubernetes|postgres|données|git|ci\/cd|node/i.test(s)), ['PostgreSQL', 'Git', 'Docker', 'Node.js']);
  assert.ok(!cv.skills.some((s) => s === 'Node'));
});
