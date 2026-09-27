/**
 * Formulaires Lever / Greenhouse simulés (servis localement), remplis par un vrai Chromium.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { submitApplicationForm, inspectForm, questionKey } from '../server/automation/forms.ts';

const received: { path: string; body: string }[] = [];
const page = (inner: string, extra = '') => `<!doctype html><html lang="fr"><body>${extra}<form method="post" enctype="multipart/form-data" action="/submit">${inner}</form></body></html>`;
const LEVER = page(`
  <div class="application-question"><label for="n">Full name ✱</label><input id="n" name="name" required></div>
  <div class="application-question"><label for="e">Email ✱</label><input id="e" type="email" name="email" required></div>
  <div class="application-question"><label for="p">Phone</label><input id="p" name="phone"></div>
  <div class="application-question"><label for="o">Current company</label><input id="o" name="org"></div>
  <div class="application-question"><label for="l">LinkedIn URL</label><input id="l" name="urls[LinkedIn]"></div>
  <div class="application-question"><label for="r">Resume/CV ✱</label><input id="r" type="file" name="resume" required></div>
  <div class="application-question"><label for="c">Additional information</label><textarea id="c" name="comments"></textarea></div>
  <button id="btn-submit" type="submit">Submit application</button>`);
const GREENHOUSE = (extra = '') => page(`
  <div class="field"><label for="fn">First Name *</label><input id="fn" name="first_name" required></div>
  <div class="field"><label for="ln">Last Name *</label><input id="ln" name="last_name" required></div>
  <div class="field"><label for="em">Email *</label><input id="em" type="email" name="email" required></div>
  <div class="field"><label for="cv">Resume/CV *</label><input id="cv" type="file" name="resume" required></div>
  <div class="field"><label for="cl">Cover Letter</label><input id="cl" type="file" name="cover_letter"></div>
  <div class="field"><label for="q1">Êtes-vous autorisé(e) à travailler en France ? *</label>
    <select id="q1" name="job_application[answers_attributes][0][boolean_value]" required><option value="">--</option><option>Oui</option><option>Non</option></select></div>
  <button id="submit_app" type="submit">Submit Application</button>`, extra);

let server: http.Server;
let base = '';
let browser: Browser;
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('latin1');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (req.method === 'POST') {
        received.push({ path: req.url || '', body });
        if (req.url!.includes('silence')) return res.end('<p>Traitement…</p>');
        res.statusCode = 303; res.setHeader('Location', '/thanks'); return res.end();
      }
      if (req.url === '/thanks') return res.end('<h1>Thank you for applying!</h1><p>Your application has been submitted.</p>');
      if (req.url!.startsWith('/lever')) return res.end(LEVER);
      if (req.url!.startsWith('/gh-captcha')) return res.end(GREENHOUSE('<div class="g-recaptcha" data-sitekey="x"></div>'));
      if (req.url!.startsWith('/gh-silence')) return res.end(GREENHOUSE().replace('action="/submit"', 'action="/submit-silence"'));
      if (req.url!.startsWith('/gh')) return res.end(GREENHOUSE());
      res.statusCode = 404; res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });
});
after(async () => { await browser?.close(); server.close(); });

const profile = { fullName: 'Karim Dupont', email: 'karim@gmail.com', phone: '06 11 22 33 44', linkedinUrl: 'https://linkedin.com/in/karim', experiences: [{ company: 'Studio X', current: true }] };
const input = (answers: Record<string, string> = {}) => ({ profile, cvPdf: Buffer.from('%PDF-1.7 CV de Karim'), cvFileName: 'CV - Karim Dupont.pdf', letter: 'Madame, Monsieur, lettre de test.', answers });
async function run(path: string, kind: 'lever' | 'greenhouse', answers: Record<string, string> = {}) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(base + path);
  const r = await submitApplicationForm(p, kind, input(answers), { confirmTimeoutMs: 3000 });
  await ctx.close();
  return r;
}

test('Lever : champs du profil remplis, CV joint, confirmation vérifiée', async () => {
  const before = received.length;
  const r = await run('/lever', 'lever');
  assert.equal(r.status, 'submitted', JSON.stringify(r));
  const body = received.slice(before)[0].body;
  assert.match(body, /name="name"\r\n\r\nKarim Dupont/);
  assert.match(body, /name="org"\r\n\r\nStudio X/);
  assert.match(body, /filename="CV - Karim Dupont\.pdf"[\s\S]*%PDF-1\.7 CV de Karim/);
  assert.match(body, /name="comments"\r\n\r\nMadame, Monsieur/);
  assert.match((r as any).proof.confirmationText, /Thank you for applying|submitted/i);
});

test('Greenhouse : question obligatoire inconnue → rien n’est envoyé, la question est posée au candidat', async () => {
  const before = received.length;
  const r = await run('/gh', 'greenhouse');
  assert.equal(r.status, 'needs_user');
  assert.equal(received.length, before, 'aucun envoi');
  assert.match((r as any).reason, /autorisé\(e\) à travailler en France/);
  assert.equal((r as any).questions[0].key, questionKey('Êtes-vous autorisé(e) à travailler en France ? *'));
});

test('Greenhouse : avec la réponse enregistrée par le candidat → envoyé, prénom et nom séparés, lettre jointe', async () => {
  const key = questionKey('Êtes-vous autorisé(e) à travailler en France ? *');
  const r = await run('/gh', 'greenhouse', { [key]: 'Oui' });
  assert.equal(r.status, 'submitted', JSON.stringify(r));
  const body = received.at(-1)!.body;
  assert.match(body, /name="first_name"\r\n\r\nKarim/);
  assert.match(body, /name="last_name"\r\n\r\nDupont/);
  assert.match(body, /boolean_value\]"\r\n\r\nOui/);
  assert.match(body, /name="cover_letter"; filename="Lettre de motivation\.txt"/);
});

test('CAPTCHA : aucun envoi, action du candidat', async () => {
  const before = received.length;
  const r = await run('/gh-captcha', 'greenhouse', { [questionKey('Êtes-vous autorisé(e) à travailler en France ? *')]: 'Oui' });
  assert.equal(r.status, 'needs_user');
  assert.match((r as any).reason, /robot/);
  assert.equal(received.length, before);
});

test('pas de confirmation après l’envoi : résultat incertain (jamais renvoyé)', async () => {
  const r = await run('/gh-silence', 'greenhouse', { [questionKey('Êtes-vous autorisé(e) à travailler en France ? *')]: 'Oui' });
  assert.equal(r.status, 'uncertain');
});

test('inspection : libellés et caractère obligatoire détectés', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(base + '/lever');
  const fields = await inspectForm(p);
  await ctx.close();
  const resume = fields.find(f => f.name === 'resume')!;
  assert.equal(resume.type, 'file');
  assert.equal(resume.required, true);
  assert.equal(fields.find(f => f.name === 'phone')!.required, false);
});
