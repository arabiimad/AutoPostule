import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

// API sans IA ni sources réelles : comportement de repli, déterministe
for (const k of ['GEMINI_API_KEY', 'LBA_API_KEY', 'FT_CLIENT_ID', 'JSEARCH_API_KEY', 'ADZUNA_APP_ID', 'JOOBLE_API_KEY', 'UPSTASH_REDIS_REST_URL']) delete process.env[k];
process.env.AUTH_MODE = 'off';
process.env.WEB_PDF = 'off';

let server: Server;
let base = '';
before(async () => {
  const { createApp } = await import('../server/app.ts');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server?.close());

const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const candidate = { fullName: 'Jeanne Martin', title: 'Développeuse', skills: ['React'], experiences: [{ title: 'Développeuse', company: 'Studio X', bullets: ['Développé une application React'] }] };
const job = { title: 'Développeur React', company: 'ACME', skillsRequired: ['React'] };

test('API : santé, mode démo et moteurs de rendu', async () => {
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.ai, false);
  const sources = await (await fetch(base + '/api/jobs/sources')).json();
  assert.equal(sources.mode, 'demo');
  const compiler = await (await fetch(base + '/api/latex/compiler')).json();
  assert.equal(compiler.web, false);
});

test('API : CV sans IA construit depuis le profil, rendu HTML, lettre modèle', async () => {
  const tailored = await (await post('/api/tailor/latex', { candidate, job })).json();
  assert.equal(tailored.source, 'profile-template');
  assert.match(tailored.latexCode, /Jeanne Martin/);
  const html = await (await post('/api/cv/html', { candidate, job, tailored: tailored.tailored })).text();
  assert.match(html, /Studio X/);
  const letter = await (await post('/api/tailor/letter', { candidate, job })).json();
  assert.equal(letter.source, 'standard-template');
  assert.match(letter.letter, /ACME/);
});

test('API : erreurs explicites (profil vide, PDF Web indisponible)', async () => {
  assert.equal((await post('/api/tailor/latex', { candidate: { experiences: [] }, job })).status, 400);
  assert.equal((await post('/api/cv/pdf', { candidate, job })).status, 501);
});
