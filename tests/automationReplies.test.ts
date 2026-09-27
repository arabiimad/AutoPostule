import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReply, isFromRecruiter, fetchReplies } from '../server/automation/replies.ts';

test('classement des réponses (français et anglais)', () => {
  assert.equal(classifyReply({ subject: 'Votre candidature', snippet: 'Nous avons bien reçu votre candidature et reviendrons vers vous.' }), 'acknowledgement');
  assert.equal(classifyReply({ subject: 'Entretien – Développeur React', snippet: 'Seriez-vous disponible pour un entretien jeudi ?' }), 'interview');
  assert.equal(classifyReply({ subject: 'Votre candidature', snippet: 'Malheureusement, nous ne pouvons pas donner suite.' }), 'rejection');
  assert.equal(classifyReply({ subject: 'Application update', snippet: 'Unfortunately we will not be moving forward.' }), 'rejection');
  assert.equal(classifyReply({ subject: 'Question', snippet: 'Pouvez-vous nous envoyer vos diplômes ?' }), 'other');
});

test('rapprochement : adresse exacte ou domaine de l’entreprise, jamais tout un domaine grand public', () => {
  assert.equal(isFromRecruiter('Julie Martin <julie.martin@datasud.fr>', 'recrutement@datasud.fr'), true);
  assert.equal(isFromRecruiter('talent@rh.datasud.fr', 'recrutement@datasud.fr'), true);
  assert.equal(isFromRecruiter('pirate@datasud.fr.evil.com', 'recrutement@datasud.fr'), false);
  assert.equal(isFromRecruiter('quelquun@gmail.com', 'petite.entreprise@gmail.com'), false);
  assert.equal(isFromRecruiter('petite.entreprise@gmail.com', 'petite.entreprise@gmail.com'), true);
});

test('Gmail : recherche des messages reçus du domaine après l’envoi (métadonnées seulement)', async () => {
  const urls: string[] = [];
  const res = await fetchReplies('gmail', 'tok', 'recrutement@datasud.fr', '2026-09-20T10:00:00Z', async (url: string) => {
    urls.push(url);
    if (url.includes('?maxResults')) return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'm1' }] }) };
    return { ok: true, status: 200, json: async () => ({ snippet: 'Seriez-vous disponible pour un entretien ?', internalDate: '1790000000000', payload: { headers: [{ name: 'From', value: 'Julie <julie@datasud.fr>' }, { name: 'Subject', value: 'Entretien' }] } }) };
  });
  assert.match(decodeURIComponent(urls[0]), /q=from:datasud\.fr after:\d+ -in:sent/);
  assert.match(urls[1], /format=metadata/);
  assert.deepEqual([res[0].id, res[0].subject, res[0].from], ['m1', 'Entretien', 'Julie <julie@datasud.fr>']);
});
