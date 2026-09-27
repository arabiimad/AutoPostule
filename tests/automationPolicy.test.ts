import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualifyOffer, annualSalaryFloor, type AutomationPolicy } from '../server/automation/policy.ts';

const profile = { title: 'Développeur web', skills: ['React', 'TypeScript', 'Node.js', 'Docker'], experiences: [{ title: 'Développeur web', company: 'Studio X', bullets: ['React'] }] };
const policy = (p: Partial<AutomationPolicy> = {}): AutomationPolicy => ({
  userId: 'u', enabled: true, paused: false, roles: ['développeur'], contracts: ['cdi'], locations: ['Avignon'], remote: [],
  minSalary: null, minFit: 50, excludedCompanies: [], excludedKeywords: [], channels: ['email'], dailyLimit: 5, followUps: false, ...p
});
const offer = (o: any = {}) => ({ title: 'Développeur React H/F', company: 'Mistral', location: '84 - Avignon', contractType: 'cdi', remote: 'hybride', skillsRequired: ['React', 'TypeScript'], description: 'Interfaces React', ...o });

test('offre conforme : retenue avec son score', () => {
  const q = qualifyOffer(policy(), profile, offer());
  assert.equal(q.ok, true, q.reason);
  assert.equal(q.score, 100);
});

test('critères bloquants : contrat, lieu, exclusions, expiration, spontanée', () => {
  const cases: [any, Partial<AutomationPolicy>, RegExp][] = [
    [offer({ contractType: 'stage' }), {}, /Contrat/],
    [offer({ contractType: undefined }), {}, /non précisé/],
    [offer({ location: 'Lyon' }), {}, /Lieu/],
    [offer({ company: 'Intérim Plus' }), { excludedCompanies: ['intérim'] }, /exclue/],
    [offer({ description: 'Mission en intérim' }), { excludedKeywords: ['Intérim'] }, /Mot exclu/],
    [offer({ expiresAt: '2020-01-01' }), {}, /expirée/],
    [offer({ isSpontaneous: true }), {}, /spontanée/],
    [offer({ title: 'Comptable' }), {}, /métiers/],
    [offer({ skillsRequired: ['Java', 'Spring', 'Kafka'] }), {}, /Adéquation/],
    [offer({ title: 'Chauffeur livreur', skillsRequired: [] }), { roles: [] }, /non évaluable|éloigné/]
  ];
  for (const [o, p, re] of cases) {
    const q = qualifyOffer(policy(p), profile, o);
    assert.equal(q.ok, false, JSON.stringify(o));
    assert.match(q.reason!, re);
  }
});

test('télétravail complet : lieu non bloquant ; salaire minimal lu dans l’offre', () => {
  assert.equal(qualifyOffer(policy(), profile, offer({ location: 'Paris', remote: 'total' })).ok, true);
  assert.equal(qualifyOffer(policy({ minSalary: 40000 }), profile, offer({ salary: 'Annuel de 30000 à 35000 Euros' })).ok, false);
  assert.equal(qualifyOffer(policy({ minSalary: 40000 }), profile, offer({ salary: undefined })).ok, true, 'salaire inconnu : non bloquant');
  assert.equal(annualSalaryFloor('38k€ - 45k€'), 38000);
  assert.equal(annualSalaryFloor('2 500 € par mois'), 30000);
});

test('tous les métiers : sans compétences reconnues, retenue si l’intitulé correspond, mais à valider par le candidat', () => {
  const aideSoignant = { title: 'Aide-soignante', targetRoles: ['Aide-soignant'], skills: ['Soins d’hygiène'], experiences: [{ title: 'Aide-soignante', company: 'EHPAD', bullets: ['Soins'] }] };
  const q = qualifyOffer(policy({ roles: ['aide-soignant'], locations: [] }), aideSoignant, offer({ title: 'Aide-soignant(e) de nuit H/F', skillsRequired: [], description: 'EHPAD, soins' }));
  assert.equal(q.ok, true, q.reason);
  assert.equal(q.score, null);
  assert.match(q.review!, /vérifiez/);
  // Métier non recherché : écartée
  assert.equal(qualifyOffer(policy({ roles: [], locations: [] }), aideSoignant, offer({ title: 'Chauffeur livreur', skillsRequired: [] })).ok, false);
  // Offre évaluable : pas de validation imposée par la politique
  assert.equal(qualifyOffer(policy(), profile, offer()).review, undefined);
});
