/**
 * Faux serveur des sources d'offres pour les tests de bout en bout (aucune clé ni réseau nécessaires).
 * Reproduit les formats réels : La bonne alternance (offres + entreprises qui recrutent), France Travail,
 * JSearch (Google Jobs), Adzuna (avec pagination) et Jooble.
 */
import http from 'node:http';

const d = (n) => new Date(Date.now() - n * 864e5).toISOString();
const lba = { jobs: [
  { identifier: { id: 'a1', partner_job_id: 'p1', partner_label: 'La bonne alternance' },
    workplace: { brand: 'Studio Pixel', name: 'STUDIO PIXEL', location: { address: '5 rue Carnot 84000 AVIGNON', geopoint: { type:'Point', coordinates: [4.8057, 43.9493] } } },
    apply: { url: 'https://labonnealternance.apprentissage.beta.gouv.fr/emploi/a1' },
    contract: { type: ['Apprentissage'], remote: 'hybrid' },
    offer: { title: 'Alternance – Développeur Full Stack React / Node.js', description: "Studio Pixel conçoit des applications web pour des collectivités et des PME de la région.\n\nVos missions :\n• Développer de nouvelles fonctionnalités en React et TypeScript\n• Concevoir des API REST en Node.js avec PostgreSQL\n• Participer aux revues de code (Git) et aux rituels Agile\n\nProfil : BAC+3 à BAC+5 en informatique, curiosité et goût du travail en équipe.\nRythme : 3 semaines en entreprise / 1 semaine en école.", desired_skills: ['Travailler en équipe'], to_be_acquired_skills: [], publication: { creation: d(2), expiration: d(-60) }, status: 'Active' } },
  { identifier: { id: 'a2', partner_job_id: 'p2', partner_label: 'Hellowork' },
    workplace: { name: 'MAIRIE DU PONTET', location: { address: 'Le Pontet 84130', geopoint: { type:'Point', coordinates: [4.86, 43.96] } } },
    apply: { url: 'https://www.hellowork.com/fr-fr/emplois/a2.html' },
    contract: { type: ['Apprentissage'], remote: null },
    offer: { title: 'Apprenti chef de projet SI', description: "Au sein de la DSI (12 personnes), vous accompagnez la modernisation des outils numériques de la ville : recueil des besoins, rédaction des cahiers des charges, recette et accompagnement des utilisateurs.\nOutils : Jira, Confluence. Gestion de projet et méthodes Agile.", desired_skills: [], to_be_acquired_skills: [], publication: { creation: d(10), expiration: null }, status: 'Active' } }
], recruiters: [
  { identifier: { id: 'r1' }, workplace: { siret: '35218860100046', brand: 'MANTIS', name: 'MANTIS', size: '10-19', website: 'mantis.fr', location: { address: '12 rue Joseph Vernet 84000 AVIGNON', geopoint: { type: 'Point', coordinates: [4.803, 43.946] } }, domain: { naf: { code: '62.01Z', label: 'Programmation informatique' } } }, apply: { url: 'https://labonnealternance.apprentissage.beta.gouv.fr/emploi/recruteurs_lba/r1' } },
  { identifier: { id: 'r2' }, workplace: { siret: '44306184100047', brand: null, name: 'PROVENCE LOGICIELS', size: '20-49', location: { address: '3 avenue de la Gare 84130 LE PONTET', geopoint: { type: 'Point', coordinates: [4.86, 43.96] } }, domain: { naf: { code: '58.29C', label: 'Édition de logiciels applicatifs' } } }, apply: { url: 'https://labonnealternance.apprentissage.beta.gouv.fr/emploi/recruteurs_lba/r2' } }
], warnings: [] };
const ft = { resultats: [
  { id: '201ABC', intitule: 'Développeur Python H/F', description: "DataSud, spécialiste de la donnée énergétique, renforce son équipe technique.\nVous développerez des services en Python (Django), conteneurisés avec Docker et déployés en CI/CD.\nExpérience : 2 ans souhaités. Télétravail 2 jours par semaine.\nCandidatures (CV et lettre de motivation) : recrutement@datasud.fr", dateCreation: d(1), lieuTravail: { libelle: '84 - AVIGNON', latitude: 43.95, longitude: 4.8 }, entreprise: { nom: 'DataSud' }, typeContrat: 'CDI', competences: [{ libelle: 'Python' }], salaire: { libelle: 'Annuel de 36000 à 42000 Euros' }, origineOffre: { urlOrigine: 'https://candidat.francetravail.fr/offres/recherche/detail/201ABC' } }
] };
const js = { status: 'OK', data: [
  { job_id: 'j1', job_title: 'Développeur Front-End React (H/F)', employer_name: 'Mistral Numérique', employer_logo: null, job_publisher: 'LinkedIn', job_employment_type: 'FULLTIME', job_apply_link: 'https://www.linkedin.com/jobs/view/1', apply_options: [{ publisher: 'LinkedIn', apply_link: 'https://www.linkedin.com/jobs/view/1' }, { publisher: 'Welcome to the Jungle', apply_link: 'https://www.welcometothejungle.com/fr/companies/mistral/jobs/1' }, { publisher: 'Indeed', apply_link: 'https://fr.indeed.com/viewjob?jk=1' }], job_description: "Mistral Numérique édite une plateforme SaaS utilisée par 300 établissements de santé.\n\nCe que vous ferez :\n- Construire des interfaces accessibles en React et TypeScript\n- Collaborer avec les designers (Figma)\n- Écrire des tests et améliorer la performance\n\nStack : React, TypeScript, Vite, Git, GitLab CI.\nAvantages : télétravail partiel, RTT, mutuelle prise en charge à 100 %.", job_is_remote: false, job_posted_at_datetime_utc: d(0), job_city: 'Avignon', job_state: "Provence-Alpes-Côte d'Azur", job_latitude: 43.9464, job_longitude: 4.8089, job_min_salary: 38000, job_max_salary: 46000, job_salary_period: 'YEAR' },
  { job_id: 'j2', job_title: 'Stage – Développeur Web (6 mois)', employer_name: 'Agence Lumen', employer_logo: null, job_publisher: 'Welcome to the Jungle', job_employment_type: 'INTERN', job_apply_link: 'https://www.welcometothejungle.com/fr/companies/lumen/jobs/2', apply_options: [], job_description: "Stage de fin d'études au sein d'une agence digitale de 20 personnes : sites vitrines, e-commerce et applications sur mesure (JavaScript, PHP, SQL).", job_is_remote: false, job_posted_at_datetime_utc: d(3), job_city: 'Avignon', job_state: 'PACA', job_min_salary: null, job_max_salary: null }
] };
const adz = { results: [
  { id: '901', title: 'Technicien <strong>support</strong> informatique', description: 'Rattaché au responsable informatique, vous assurez le support utilisateurs (N1/N2), la gestion du parc et…', company: { display_name: 'Groupe Provence Santé' }, location: { display_name: 'Avignon, Vaucluse' }, created: d(4), redirect_url: 'https://www.adzuna.fr/details/901', contract_type: 'permanent', salary_min: 26000, salary_max: 30000, salary_is_predicted: '0', latitude: 43.93, longitude: 4.84, category: { label: 'Emplois Informatique' } },
  { id: '902', title: 'Développeur Front-End React (H/F)', description: 'Construire des interfaces accessibles en React…', company: { display_name: 'Mistral Numérique' }, location: { display_name: 'Avignon, Vaucluse' }, created: d(0), redirect_url: 'https://www.adzuna.fr/details/902', contract_type: 'permanent' }
] };
const jbl = { totalCount: 1, jobs: [{ id: 77, title: 'Développeur PHP Symfony H/F', company: 'Sud Web Services', location: 'Avignon', snippet: '...PHP, Symfony, MySQL, <b>Docker</b>... CDI, télétravail partiel...', salary: '32 000 € - 38 000 € par an', source: 'indeed.fr', type: 'CDI', link: 'https://jooble.org/desc/77', updated: d(5) }] };

// Recherche « comptable » : 50 offres Adzuna en page 1, 8 en page 2 (bouton « Charger plus »)
const adzPage = (page) => ({
  results: Array.from({ length: page === 1 ? 50 : 8 }, (_, i) => ({
    id: `c${page}-${i}`, title: `Comptable ${page === 1 ? '' : 'senior '}n°${i + 1}`, description: 'Comptabilité générale, clôtures mensuelles. CDI.',
    company: { display_name: `Cabinet ${page}-${i}` }, location: { display_name: 'Avignon, Vaucluse' }, created: d(i % 20),
    redirect_url: `https://www.adzuna.fr/details/c${page}-${i}`, contract_type: 'permanent'
  }))
});

// Faux Gemini : le modèle Pro répond « facturation requise » (repli sur Flash), Flash répond selon le prompt.
function gemini(req, res, u) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const model = (u.match(/models\/([^:]+):/) || [])[1] || '';
    if (/pro/.test(model)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'This model requires a billing-enabled project.' } }));
    }
    const prompt = JSON.stringify(JSON.parse(body || '{}').contents || '');
    // Quota gratuit épuisé (même réponse que Google) : déclenché par une offre de test
    if (prompt.includes('QUOTA-E2E')) {
      res.statusCode = 429;
      return res.end(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20' } }));
    }
    let text = '';
    if (prompt.includes('Analyse cette offre')) {
      text = JSON.stringify({ domain: 'Développement web', tone: 'technique', mustHave: ['React', 'TypeScript'], missions: ['Développer des interfaces'], softSkills: ['Rigueur'], keywords: ['React'] });
    } else if (prompt.includes('Adapte le CONTENU')) {
      const ids = [...prompt.matchAll(/\\"id\\":\\"([^\\"]+)\\"/g)].map((m) => m[1]);
      text = JSON.stringify({
        headline: 'Développeur React — profil adapté',
        summary: 'Développeur full stack orienté React et Node.js, habitué aux API REST.',
        experiences: ids.map((id) => ({ id, include: true, bullets: ['Développé des interfaces React et des API REST en Node.js', 'Réduit les coûts de 40 % grâce à Kubernetes'] })),
        skillsOrder: ['React', 'TypeScript', 'Node.js'],
        highlights: ['Maîtrise de React et TypeScript']
      });
    } else if (prompt.includes('relecteur de CV')) {
      // Relecture sémantique : approuve les propositions restantes (les garde-fous déterministes ont déjà filtré)
      text = JSON.stringify({ approved: [...prompt.matchAll(/\\"ref\\":\\"([^\\"]+)\\"/g)].map((m) => m[1]) });
    } else if (prompt.includes('Réécris')) {
      text = JSON.stringify({ text: 'Conçu des interfaces React accessibles et des API REST en Node.js' });
    } else {
      text = 'Madame, Monsieur,\n\nLettre de test générée par le faux Gemini pour vérifier la chaîne complète de génération.\n\nCordialement,';
    }
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] }));
  });
}

/** Messages reçus par la fausse API Gmail. */
export const mailbox = [];

export function startMockSources(port = 4011) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = req.url || '';
      const url = new URL(u, 'http://x');
      res.setHeader('Content-Type', 'application/json');
      if (u.startsWith('/geo')) return res.end(JSON.stringify([{ nom: 'Avignon', code: '84007', codeDepartement: '84', centre: { type: 'Point', coordinates: [4.8, 43.94] } }]));
      if (u.startsWith('/rome')) return res.end(JSON.stringify({ labelsAndRomes: [{ label: 'Développement web, intégration', romes: ['M1805', 'M1855'] }] }));
      if (u.startsWith('/lba/job/v1/search')) return res.end(JSON.stringify(lba));
      if (u.startsWith('/ft/token')) return res.end(JSON.stringify({ access_token: 'tok', expires_in: 1499 }));
      if (u.startsWith('/ft/search')) {
        if (/comptable/.test(url.searchParams.get('motsCles') || '')) { res.statusCode = 204; return res.end(); }
        res.statusCode = 206; return res.end(JSON.stringify(ft));
      }
      if (u.startsWith('/rapidapi/search')) return res.end(JSON.stringify(/comptable/i.test(url.searchParams.get('query') || '') ? { data: [] } : js));
      if (u.startsWith('/adz')) {
        const page = Number((u.match(/\/search\/(\d+)/) || [])[1] || 1);
        if (/comptable/i.test(url.searchParams.get('what') || '')) return res.end(JSON.stringify(adzPage(page)));
        return res.end(JSON.stringify(page === 1 ? adz : { results: [] }));
      }
      if (u.startsWith('/jbl')) return res.end(JSON.stringify(jbl));
      if (u.includes(':generateContent')) return gemini(req, res, u);
      // Fausse API Gmail : messages reçus conservés pour les vérifications (worker d'auto-candidature)
      if (u.startsWith('/gmail/send') && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const raw = Buffer.from(JSON.parse(body || '{}').raw || '', 'base64url').toString('utf8');
          mailbox.push({ auth: req.headers.authorization || '', raw });
          res.end(JSON.stringify({ id: `gmail-${mailbox.length}` }));
        });
        return;
      }
      if (u.startsWith('/gmail/sent')) return res.end(JSON.stringify(mailbox));
      res.statusCode = 404; res.end('{}');
    });
    server.listen(port, () => resolve(server));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMockSources(Number(process.env.MOCK_PORT) || 4011).then(() => console.log('Sources simulées sur le port', process.env.MOCK_PORT || 4011));
}
