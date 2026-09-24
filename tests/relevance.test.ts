import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripApplicationInstructions } from '../server/jobSources.ts';
import { extractTechnologies } from '../src/semanticCvParser.ts';
import { isFarFromProfile, calculateCandidateMatch } from '../src/utils/skillMatcher.ts';

const MACON = `Notre agence recherche un maçon traditionnel N3 (H/F). Vous participerez au coulage béton, à la pose parpaings.
Vous devez impérativement avoir le permis B. Merci de postuler ici en joignant un CV actualisé sous format Word ou PDF.`;

test('offre de maçon : « CV au format Word » ne devient pas la compétence « Pack Office »', () => {
  assert.ok(extractTechnologies(MACON).some((s) => /Pack Office/.test(s)), 'le problème existait sans filtrage');
  const skills = extractTechnologies(stripApplicationInstructions(MACON));
  assert.ok(!skills.some((s) => /Pack Office/.test(s)), skills.join(', '));
  assert.equal(calculateCandidateMatch(['Pack Office (Word, PowerPoint, Excel)'], skills).score, null);
});

test('consignes retirées, description du poste conservée', () => {
  const kept = stripApplicationInstructions(MACON);
  assert.match(kept, /coulage béton/);
  assert.doesNotMatch(kept, /format Word/);
});

const chefProjet = { title: 'Chef de projet informatique', targetRoles: ['Chef de projet AMOA'], skills: ['Gestion de projet', 'SQL'], experiences: [{ title: 'Chef de projet informatique' }, { title: 'Développeur full stack' }] };

test('proximité métier : maçon éloigné d’un profil informatique, développeur proche', () => {
  assert.equal(isFarFromProfile(chefProjet, { title: 'Maçon traditionnel N3 (h/f) (H/F)', skillsRequired: [] }), true);
  assert.equal(isFarFromProfile(chefProjet, { title: 'Chef de projet digital H/F', skillsRequired: [] }), false);
  assert.equal(isFarFromProfile(chefProjet, { title: 'Candidature spontanée — Développeur web', skillsRequired: [] }), false);
  // Métier différent mais compétence demandée présente : pas « éloigné »
  assert.equal(isFarFromProfile(chefProjet, { title: 'Analyste données', skillsRequired: ['SQL'] }), false);
});

import { assessFit } from '../src/utils/skillMatcher.ts';

test('adéquation : niveau expliqué, jamais optimiste sans information', () => {
  const dev = { title: 'Développeur full stack', skills: ['React', 'Node.js', 'SQL'], experiences: [{ title: 'Développeur web' }] };
  const strong = assessFit(dev, { title: 'Développeur React H/F', skillsRequired: ['React', 'Node.js', 'TypeScript'] });
  assert.equal(strong.level, 'forte');
  assert.ok(strong.reasons.some((r) => /Métier proche/.test(r)) && strong.reasons.some((r) => /2 compétences demandées sur 3/.test(r)), strong.reasons.join(' | '));
  assert.equal(assessFit(dev, { title: 'Maçon traditionnel N3 (H/F)', skillsRequired: [] }).level, 'faible');
  // Offre sans compétences listées mais même métier : moyenne (pas forte)
  assert.equal(assessFit(dev, { title: 'Développeur', skillsRequired: [] }).level, 'moyenne');
  // Profil vide : pas de niveau
  assert.equal(assessFit({ skills: [] }, { title: 'Développeur', skillsRequired: ['React'] }).level, null);
  // Métier différent, une seule compétence commune : non évaluable plutôt qu'un faux 100 %
  assert.equal(assessFit(dev, { title: 'Comptable', skillsRequired: ['SQL'] }).level, null);
});
