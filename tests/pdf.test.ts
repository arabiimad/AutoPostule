import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCvHtml, generatePdfFromHtml, getSectorColor, escapeHtml, closeBrowser } from '../server/pdf.ts';

// Le navigateur partagé garderait le processus de test ouvert
after(() => closeBrowser());

const candidate = {
  fullName: 'Sarah Benali <script>',
  title: 'Chargée de communication',
  email: 'sarah@example.com',
  skills: ['Canva', 'SEO'],
  experiences: [
    {
      title: 'Chargée com',
      company: 'Lumen & Co',
      startDate: '2022',
      current: true,
      bullets: ['Budget 5k€ & C:\\temp', 'Pilotage : 3 prestataires externes']
    }
  ],
  education: [
    {
      year: '2021',
      degree: 'Master Communication',
      institution: 'Université Paris 1'
    }
  ]
};

const job = {
  title: 'Chargée de communication digitale',
  company: 'Acme Corp',
  skillsRequired: ['Canva', 'Pack Office']
};

test('échappement HTML sécurisé', () => {
  assert.equal(escapeHtml('<script>alert("xss")&\'</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&amp;&#039;&lt;/script&gt;');
});

test('couleurs sectorielles adaptatives', () => {
  assert.equal(getSectorColor('Finance & Banque').hex, '#1e50a0');
  assert.equal(getSectorColor('Design & Luxe').hex, '#8c1e3c');
  assert.equal(getSectorColor('Biotechnologies & Santé').hex, '#0f766e');
  assert.equal(getSectorColor('Informatique / Web').hex, '#3c963c');
  assert.equal(getSectorColor(undefined, '#123456').hex, '#123456');
});

for (const template of ['article', 'moderncv', 'compact'] as const) {
  test(`rendu HTML du modèle ${template} : structure et données réelles`, () => {
    const html = renderCvHtml(candidate, job, template, 'Finance');
    assert.match(html, /Sarah Benali &lt;script&gt;/);
    assert.match(html, /Lumen &amp; Co/);
    assert.match(html, /Master Communication/);
    assert.match(html, /<strong>Pilotage :<\/strong>/);
    // Compétence requise en surbrillance
    assert.match(html, /class="skill-pill matched">Canva<\/span>/);
    // Compétence non possédée 'Pack Office' ne doit pas être inventée dans les compétences du candidat
    assert.doesNotMatch(html, /Pack Office/);
  });
}

test('génération PDF Chromium Playwright', async () => {
  const html = renderCvHtml(candidate, job, 'article');
  const pdf = await generatePdfFromHtml(html);
  assert.ok(pdf && pdf.length > 5000);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
});
