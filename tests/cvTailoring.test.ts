import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tailorCvContent } from '../server/cvTailoring.ts';
import { generateFallbackLatex } from '../server/latex.ts';
import type { UserProfile } from '../src/types.ts';

const candidate = {
  fullName: 'Camille', skills: ['Photoshop'], summary: 'Profil source',
  education: [{ degree: 'Licence', year: '2024' }], languages: ['Français'],
  experiences: [{ company: 'Entreprise', title: 'Assistante', startDate: '2023',
    bullets: ['Participation au suivi de 3 projets', 'Création de supports visuels'] }]
} as UserProfile;
const first = 'experience:0:bullet:0';
const second = 'experience:0:bullet:1';
function responses(...values: unknown[]) {
  let count = 0;
  return async (_prompt: string, schema: object) => {
    assert.ok(schema);
    assert.ok(count < values.length, 'unexpected model call');
    return values[count++];
  };
}

test('reviewed prose is rendered by every fixed template; metadata stays unchanged', async () => {
  const before = JSON.stringify(candidate);
  const result = await tailorCvContent(candidate, {}, responses(
    { requirements: ['Suivi de projets'] },
    { bullets: [{ sourceId: first, text: 'Contribution au suivi de 3 projets' }] },
    { approvedSourceIds: [first] }
  ));
  assert.equal(JSON.stringify(candidate), before);
  assert.equal(result.profile.experiences[0].title, 'Assistante');
  assert.deepEqual(result.profile.education, candidate.education);
  assert.deepEqual(result.profile.skills, candidate.skills);
  assert.equal(result.retainedOriginalCount, 1);
  assert.equal(result.audit[0].sourceId, first);
  for (const template of ['article', 'compact', 'moderncv'] as const) {
    assert.match(generateFallbackLatex(result.profile, {}, template), /Contribution au suivi de 3 projets/);
  }
});

test('unsupported responsibilities rejected by review retain the original bullet', async () => {
  const result = await tailorCvContent(candidate, {}, responses(
    { requirements: ['Management'] },
    { bullets: [{ sourceId: second, text: 'Direction du service communication' }] },
    { approvedSourceIds: [] }
  ));
  assert.deepEqual(result.profile.experiences, candidate.experiences);
});

test('unknown, duplicate, oversized and numerical changes fail closed before review', async () => {
  for (const bullets of [
    [{ sourceId: 'fake', text: 'Support' }],
    [{ sourceId: first, text: 'Gestion de 30 projets' }],
    [{ sourceId: first, text: 'Gestion de projets' }],
    [{ sourceId: second, text: 'x'.repeat(601) }],
    [{ sourceId: second, text: 'Support' }, { sourceId: second, text: 'Support' }]
  ]) {
    await assert.rejects(tailorCvContent(candidate, {}, responses({ requirements: [] }, { bullets })));
  }
});

test('invalid analysis and review fail closed', async () => {
  await assert.rejects(tailorCvContent(candidate, {}, responses({ requirements: 'bad' })));
  await assert.rejects(tailorCvContent(candidate, {}, responses(
    { requirements: [] }, { bullets: [] }, { approvedSourceIds: ['fake'] }
  )));
});

test('offer compound skills never enter the rendered candidate skills', () => {
  const tex = generateFallbackLatex(candidate, { skillsRequired: ['Photoshop et Illustrator'] });
  assert.match(tex, /Photoshop/);
  assert.doesNotMatch(tex, /Illustrator/);
});
