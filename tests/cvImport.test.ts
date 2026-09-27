import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportedProfile, importWarnings } from '../src/utils/cvImport.ts';

const current: any = {
  userId: 'u', fullName: 'Karim Dupont', title: 'Comptable', email: 'karim@gmail.com', phone: '06 00 00 00 00', summary: 'Ancienne accroche',
  linkedinUrl: 'https://linkedin.com/in/ancien', skills: ['Sage'], experiences: [{ id: 'old', title: 'Comptable', company: 'Ancien', bullets: [] }],
  education: [{ id: 'e', degree: 'BTS', institution: 'X', year: '2015' }], projects: [], languages: ['Français'],
  preferredContracts: ['cdi'], minMatchScore: 70, preferredTemplate: 'compact', savedSearches: [{ id: 's' }]
};
const parsed = { fullName: 'Karim Dupont', title: 'Développeur web', email: '', skills: ['React'], experiences: [{ title: 'Développeur', company: 'Studio X', startDate: '2021', bullets: ['React'] }], education: [], languages: [] };

test('remplacement (par défaut) : rien de l’ancien profil ne se mélange au nouveau CV', () => {
  const { profile, keptFromPrevious } = buildImportedProfile(current, parsed, 'replace');
  assert.deepEqual(keptFromPrevious, []);
  assert.equal(profile.summary, '', 'ancienne accroche non reprise');
  assert.equal(profile.phone, '');
  assert.equal(profile.linkedinUrl, '');
  assert.deepEqual(profile.experiences.map(e => e.company), ['Studio X']);
  assert.deepEqual(profile.education, []);
  assert.deepEqual(profile.skills, ['React']);
  // Réglages du compte conservés
  assert.deepEqual([profile.preferredContracts, profile.minMatchScore, profile.preferredTemplate, profile.savedSearches?.length], [['cdi'], 70, 'compact', 1]);
  assert.equal(profile.email, 'karim@gmail.com', 'e-mail du compte gardé si le CV n’en a pas');
  assert.deepEqual(profile.targetRoles, ['Développeur web']);
});

test('complément : champs absents du CV repris de l’ancien profil, et listés', () => {
  const { profile, keptFromPrevious } = buildImportedProfile(current, parsed, 'complete');
  assert.equal(profile.summary, 'Ancienne accroche');
  assert.deepEqual(profile.education.map(e => e.degree), ['BTS']);
  assert.ok(keptFromPrevious.includes('accroche') && keptFromPrevious.includes('formations') && keptFromPrevious.includes('téléphone'), keptFromPrevious.join());
  assert.deepEqual(profile.experiences.map(e => e.company), ['Studio X'], 'les expériences du CV remplacent les anciennes');
});

test('champs incertains signalés ; CV d’une autre personne signalé', () => {
  const w = importWarnings({ fullName: 'Julie Martin', experiences: [{ title: 'Poste', company: '', bullets: [] }], education: [{ degree: 'Formation' }], skills: [] }, current);
  const msgs = w.map(x => x.message).join('\n');
  assert.match(msgs, /au nom de « Julie Martin »/);
  assert.match(msgs, /intitulé du poste non reconnu/);
  assert.match(msgs, /entreprise non reconnue/);
  assert.match(msgs, /dates non reconnues/);
  assert.match(msgs, /diplôme non reconnu/);
  assert.match(msgs, /Aucune compétence/);
  assert.equal(importWarnings({ ...parsed, email: 'k@x.fr', phone: '06' }, current).filter(x => x.level === 'important').length, 0);
});
