import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCvSemantically, isParsedCvEmpty, extractTechnologies } from '../src/semanticCvParser.ts';

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

test('compétences du profil : seuls les outils écrits dans le CV, jamais un nom de groupe', () => {
  const p = parseCvSemantically('Karim Dupont\nDéveloppeur\nkarim@mail.fr\nEXPÉRIENCES\nDéveloppeur - Studio X | 2021 - Présent\nMise en place de Docker et MySQL, retouches Photoshop\nCOMPÉTENCES\nReact, aws, ci/cd, UI/UX / Figma');
  for (const s of ['Docker', 'MySQL', 'Photoshop', 'AWS', 'CI/CD', 'UI/UX', 'Figma', 'React']) assert.ok(p.skills.includes(s), `${s} manquant : ${p.skills}`);
  assert.ok(!p.skills.some(s => /Kubernetes|Illustrator|InDesign|PostgreSQL|GCP|Azure/.test(s)), `compétence inventée : ${p.skills}`);
  assert.ok(!p.skills.includes('ci') && !p.skills.includes('cd'));
});

test('offres : les noms de groupe du catalogue restent utilisés pour le calcul du score', () => {
  assert.deepEqual(extractTechnologies('Stack : Docker, Git'), ['Docker & Kubernetes', 'Git & CI/CD']);
});

test('poste / entreprise et diplôme / établissement séparés par un tiret long ou une virgule', () => {
  const p = parseCvSemantically('Karim Dupont\nkarim@mail.fr\nEXPÉRIENCES\n2021 – Présent Développeur — Studio X\n- Développement React et API\nFORMATION\nLicence informatique — Avignon Université 2021\nBTS SIO, Lycée Mistral 2019\nCOMPÉTENCES\nReact');
  assert.equal(p.experiences[0].title, 'Développeur');
  assert.equal(p.experiences[0].company, 'Studio X');
  assert.deepEqual(p.education.map(e => [e.degree, e.institution, e.year]), [
    ['Licence informatique', 'Avignon Université', '2021'],
    ['BTS SIO', 'Lycée Mistral', '2019']
  ]);
});
