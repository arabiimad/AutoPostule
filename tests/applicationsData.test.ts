import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeStats, applicationsToCsv, applicationsBackup, parseApplicationsBackup } from '../src/utils/applicationsData.ts';
import { extractTextFromDocx } from '../server/docx.ts';
import type { Application } from '../src/types.ts';

const NOW = new Date('2026-09-23T12:00:00Z').getTime();
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const app = (p: Partial<Application>): Application => ({
  id: Math.random().toString(36).slice(2), userId: 'u', jobId: 'j', jobTitle: 'Développeur', company: 'ACME', location: 'Lyon',
  contractType: 'cdi', jobUrl: 'https://x', matchScore: 50, status: 'applied', latexResumeCode: '', coverLetter: '',
  overleafSnippetUrl: '', createdAt: day(20), matchedKeywords: [], logEvents: [], ...p
});

test('statistiques : taux de réponse, délai médian, sources, rythme hebdomadaire', () => {
  const apps = [
    app({ status: 'applied', appliedAt: day(3), jobSource: 'LinkedIn' }),
    app({ status: 'interview', appliedAt: day(10), respondedAt: day(6), jobSource: 'LinkedIn' }),
    app({ status: 'rejected', appliedAt: day(12), respondedAt: day(4), jobSource: 'France Travail' }),
    app({ status: 'prepared' }),
    app({ status: 'detected', matchScore: null })
  ];
  const st = computeStats(apps, NOW);
  assert.equal(st.total, 5);
  assert.equal(st.sent, 3);
  assert.equal(st.responses, 2);
  assert.equal(st.responseRate, 67);
  assert.equal(st.interviewRate, 33);
  assert.equal(st.medianResponseDays, 6); // délais 4 et 8 jours
  assert.deepEqual(st.bySource[0], { source: 'LinkedIn', sent: 2, responses: 1 });
  assert.equal(st.weekly.length, 8);
  assert.equal(st.weekly.reduce((n, w) => n + w.count, 0), 3);
  assert.equal(computeStats([], NOW).responseRate, null);
});

test('export CSV (Excel) et sauvegarde JSON réimportable', () => {
  const apps = [app({ company: 'Café "Le Pont"; SAS', status: 'offer', matchScore: null })];
  const csv = applicationsToCsv(apps);
  assert.ok(csv.startsWith('﻿Entreprise;Poste'));
  assert.ok(csv.includes('"Café ""Le Pont""; SAS"'), 'guillemets et « ; » échappés');
  assert.ok(csv.includes('Offre reçue'));
  const restored = parseApplicationsBackup(applicationsBackup(apps));
  assert.equal(restored.length, 1);
  assert.equal(restored[0].company, apps[0].company);
  assert.throws(() => parseApplicationsBackup('{"foo":1}'), /invalide/);
});

test('CV Word (.docx) : texte extrait sans dépendance', () => {
  const text = extractTextFromDocx(fs.readFileSync('tests/fixtures/cv-exemple.docx'));
  assert.match(text, /Jeanne Martin/);
  assert.match(text, /React, TypeScript, Node\.js/);
  assert.match(text, /Studio Pixel \| 2023 - Présent/);
  assert.throws(() => extractTextFromDocx(Buffer.from('pas un zip')), /illisible/);
});
