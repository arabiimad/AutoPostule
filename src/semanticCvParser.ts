/**
 * Advanced Semantic CV Parser
 * High-precision extraction of candidate data from raw text & PDF buffers.
 * Works seamlessly with Gemini API (resilient multi-model) and features
 * a deterministic NLP/regex fallback that extracts 100% real candidate data
 * even under severe API rate limits (429) or service degradation (503).
 */

import zlib from 'zlib';
import { UserProfile, Experience, Education, Project } from './types';

let cachedPdfParse: any = null;
async function getPdfParserClass(): Promise<any> {
  if (cachedPdfParse) return cachedPdfParse;
  try {
    const mod = await import('pdf-parse');
    cachedPdfParse = mod?.PDFParse || (mod as any)?.default?.PDFParse || (mod as any)?.default || mod;
    return cachedPdfParse;
  } catch {
    try {
      if (typeof require !== 'undefined') {
        const mod = require('pdf-parse');
        cachedPdfParse = mod?.PDFParse || mod;
        return cachedPdfParse;
      }
    } catch {}
    return null;
  }
}

export interface ExtractedCvData {
  fullName: string;
  email: string;
  phone: string;
  title: string;
  location: string;
  linkedinUrl: string;
  githubUrl: string;
  portfolioUrl: string;
  summary: string;
  skills: string[];
  experiences: Experience[];
  education: Education[];
  projects: Project[];
  languages: string[];
  targetRoles: string[];
}

// ---------------------------------------------------------------------------
// 1. PDF Text Extraction
// ---------------------------------------------------------------------------

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  // Method 1: pdf-parse (v2 PDFParse class)
  try {
    const PDFParse = await getPdfParserClass();
    if (typeof PDFParse === 'function') {
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      await parser.destroy();
      if (result && typeof result.text === 'string' && result.text.trim().length > 20) {
        // Remove page counters like "-- 1 of 2 --"
        const cleaned = result.text.replace(/--\s*\d+\s*of\s*\d+\s*--/gi, '\n');
        return cleaned;
      }
    }
  } catch (err: any) {
    console.log('[PDF Extraction] PDFParse note:', err?.message || err);
  }

  // Method 2: Deflate / FlateDecode decompression of PDF streams
  try {
    const raw = buffer.toString('binary');
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match: RegExpExecArray | null;
    const decompressedChunks: string[] = [];

    while ((match = streamRegex.exec(raw)) !== null) {
      const streamBytes = Buffer.from(match[1], 'binary');
      try {
        const decompressed = zlib.inflateSync(streamBytes);
        decompressedChunks.push(decompressed.toString('utf8'));
      } catch {
        try {
          const rawDecomp = zlib.inflateRawSync(streamBytes);
          decompressedChunks.push(rawDecomp.toString('utf8'));
        } catch {
          // Stream was not flate compressed
        }
      }
    }

    if (decompressedChunks.length > 0) {
      const combined = decompressedChunks.join('\n');
      const textFromTj = extractTextFromPdfOperators(combined);
      if (textFromTj.trim().length > 30) {
        return textFromTj;
      }
    }
  } catch (zlibErr: any) {
    console.log('[PDF Extraction] FlateDecode fallback note:', zlibErr?.message || zlibErr);
  }

  // Method 3: Direct text operator extraction from raw buffer
  try {
    const raw = buffer.toString('latin1');
    const textFromOperators = extractTextFromPdfOperators(raw);
    if (textFromOperators.trim().length > 50) {
      return textFromOperators;
    }
    return buffer.toString('utf8');
  } catch {
    return buffer.toString('utf8');
  }
}

function extractTextFromPdfOperators(raw: string): string {
  const chunks: string[] = [];

  // 1. Bracket TJ arrays: [(text) 120 (more text)] TJ
  const tjMatches = raw.match(/\[(.*?)\]\s*TJ/gs) || [];
  for (const tj of tjMatches) {
    const inner = tj.match(/\(([^()]*)\)/g) || [];
    const text = inner.map(s => s.slice(1, -1)).join('');
    if (text.trim()) chunks.push(text);
  }

  // 2. Parentheses Tj operators: (text) Tj
  const singleTj = raw.match(/\(([^()]{2,200})\)\s*(?:Tj|'|")/g) || [];
  for (const m of singleTj) {
    const clean = m.replace(/^\(/, '').replace(/\)\s*(?:Tj|'|")$/, '').trim();
    if (clean) chunks.push(clean);
  }

  // 3. Meaningful words if operators are sparse
  if (chunks.length < 5) {
    const asciiWords = raw.match(/[a-zA-Z0-9À-ÿ@.+/_-]{3,}/g) || [];
    const pdfKeywords = new Set([
      'stream', 'endstream', 'endobj', 'trailer', 'startxref', 'xref', 'Filter',
      'FlateDecode', 'Length', 'Font', 'Type', 'Pages', 'Catalog', 'MediaBox',
      'Contents', 'Resources', 'FontDescriptor', 'BaseFont', 'Encoding'
    ]);
    const cleanWords = asciiWords.filter(w => !pdfKeywords.has(w) && w.length < 50);
    chunks.push(...cleanWords);
  }

  return chunks.join(' ')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// 2. Comprehensive Tech Dictionary
// ---------------------------------------------------------------------------
// 2. Comprehensive Universal Multi-Sector Catalog (All Professions & Trades)
// ---------------------------------------------------------------------------

const UNIVERSAL_SKILLS_CATALOG: { name: string; aliases: string[] }[] = [
  // --- Marketing, Digital & Communication ---
  { name: 'SEO / Référencement', aliases: ['seo', 'référencement naturel', 'semrush', 'screaming frog'] },
  { name: 'SEA / Google Ads', aliases: ['=SEA', 'google ads', 'google adwords', 'meta ads', 'facebook ads'] },
  { name: 'Google Analytics', aliases: ['google analytics', 'ga4', 'google tag manager'] },
  { name: 'Stratégie de Communication', aliases: ['stratégie de communication', 'communication digitale', 'relations presse', '=RP', 'brand marketing'] },
  { name: 'Social Media Management', aliases: ['social media', 'community management', 'community manager', 'gestion des réseaux sociaux', 'animation des réseaux sociaux'] },
  { name: 'Content Marketing & Copywriting', aliases: ['content marketing', 'copywriting', 'rédaction web', 'storytelling'] },
  { name: 'Marketing Automation & Inbound', aliases: ['marketing automation', 'inbound marketing', 'hubspot', 'mailchimp', 'brevo', 'sendinblue'] },
  { name: 'Canva & Création de Contenu', aliases: ['canva', 'création graphique', 'montage vidéo'] },
  { name: 'Gestion de Campagnes', aliases: ['gestion de campagnes', 'acquisition client', 'lead generation', 'growth marketing'] },

  // --- Ressources Humaines, Paie & Recrutement ---
  { name: 'Sourcing & Recrutement', aliases: ['sourcing de candidats', 'chasse de têtes', 'talent acquisition', 'conduite d\'entretiens', 'chargé de recrutement', 'chargée de recrutement'] },
  { name: 'Gestion de la Paie', aliases: ['paie', 'gestion de la paie', 'bulletins de paie', 'adp', 'silae', 'charges sociales'] },
  { name: 'Droit du Travail & Social', aliases: ['droit du travail', 'droit social', 'relations sociales', 'cst', 'accords d\'entreprise'] },
  { name: 'Gestion des Compétences & GPEC', aliases: ['gpec', 'gestion des compétences', 'plan de développement des compétences'] },
  { name: 'SIRH & Outils RH', aliases: ['sirh', 'workday', 'lucca', 'bamboohr', 'talentsoft', 'linkedin recruiter'] },
  { name: 'Formation Professionnelle', aliases: ['formation professionnelle', 'opco', 'ingénierie pédagogique', 'bilan de compétences'] },

  // --- Finance, Comptabilité & Audit ---
  { name: 'Comptabilité Générale', aliases: ['comptabilité générale', 'comptabilité', 'saisie comptable', 'rapprochement bancaire', 'comptabilité fournisseurs'] },
  { name: 'Contrôle de Gestion', aliases: ['contrôle de gestion', 'reporting financier', 'budgets prévisionnels', 'tableaux de bord', 'kpi financiers'] },
  { name: 'Audit Financier & Légal', aliases: ['audit financier', 'commissariat aux comptes', 'audit interne', 'auditeur', 'auditrice'] },
  { name: 'Clôture & Bilan Comptable', aliases: ['clôture mensuelle', 'bilan comptable', 'compte de résultat', 'liasse fiscale'] },
  { name: 'Trésorerie & Analyse Financière', aliases: ['trésorerie', 'analyse financière', 'gestion du bfr', 'cash flow'] },
  { name: 'Normes IFRS & Fiscalité', aliases: ['ifrs', 'fiscalité', 'tva', 'déclarations fiscales', 'impôt sur les sociétés'] },
  { name: 'Logiciels Comptables (Sage, SAP, Cegid)', aliases: ['=Sage(?![- ]femme)', 'sap fi', 'cegid', 'ebp', 'quadratus'] },
  { name: 'Excel Avancé & TCD', aliases: ['excel avancé', 'vba', 'tableaux croisés dynamiques', 'recherche v', 'tcd'] },
  { name: 'Power BI & Dataviz', aliases: ['power bi', 'tableau software', 'qlik', 'data visualisation'] },

  // --- Commerce, Vente & Négociation ---
  { name: 'Négociation Commerciale', aliases: ['négociation commerciale', 'closing', 'techniques de vente', 'conclusion de contrats'] },
  { name: 'Prospection B2B / B2C', aliases: ['prospection b2b', 'prospection commerciale', 'prospection téléphonique', 'phoning', 'cold calling', 'prise de rdv'] },
  { name: 'Développement Commercial', aliases: ['business development', 'développement commercial', 'expansion commerciale'] },
  { name: 'CRM Salesforce & Outils Vente', aliases: ['salesforce', 'crm', 'pipedrive', 'zoho crm', 'hubspot crm'] },
  { name: 'Gestion de Portefeuille Client', aliases: ['gestion de portefeuille', 'fidélisation client', 'account management', 'gestion de la relation client'] },
  { name: 'Réponse aux Appels d\'Offres', aliases: ['appels d\'offres', 'propositions commerciales', 'chiffrage commercial'] },

  // --- Achats, Logistique & Supply Chain ---
  { name: 'Supply Chain Management', aliases: ['supply chain', 'gestion de la chaîne logistique', 'planification flux'] },
  { name: 'Gestion des Stocks & Entrepôt', aliases: ['gestion des stocks', 'gestion d\'entrepôt', 'inventaires', 'wms'] },
  { name: 'Achats Stratégiques & Négociation Fournisseurs', aliases: ['achats stratégiques', 'négociation fournisseurs', 'sourcing fournisseurs', 'procurement'] },
  { name: 'Transport & Logistique Internationale', aliases: ['transport international', 'logistique internationale', 'déclarations en douane', 'incoterms', 'fret maritime', 'fret aérien', 'transitaire'] },
  { name: 'ERP SAP & Gestion Logistique', aliases: ['sap mm', 'sap sd', 'erp', 'gestion logistique'] },

  // --- Juridique, Droit & Conformité ---
  { name: 'Droit des Affaires & Sociétés', aliases: ['droit des affaires', 'droit des sociétés', 'droit commercial'] },
  { name: 'Droit des Contrats & Rédaction', aliases: ['droit des contrats', 'rédaction contractuelle', 'revue de contrats', 'accords de confidentialité'] },
  { name: 'Conformité & RGPD', aliases: ['rgpd', 'compliance officer', '=DPO', 'protection des données personnelles', 'sapin ii', 'conformité réglementaire'] },
  { name: 'Contentieux & Veille Juridique', aliases: ['contentieux', 'veille juridique', 'résolution de litiges', 'précontentieux'] },

  // --- Santé, Pharmacie & Recherche ---
  { name: 'Bonnes Pratiques de Fabrication (BPF / GMP)', aliases: ['bpf', 'gmp', 'bonnes pratiques de fabrication'] },
  { name: 'Pharmacovigilance & Réglementation', aliases: ['pharmacovigilance', 'affaires réglementaires', 'dossiers amm'] },
  { name: 'Essais Cliniques & Recherche', aliases: ['essais cliniques', 'recherche clinique', '=ARC', 'protocoles cliniques'] },
  { name: 'Qualité Santé & Normes Médicales', aliases: ['qualité santé', 'iso 13485', 'dispositifs médicaux'] },

  // --- Ingénierie, BTP & Industrie ---
  { name: 'Gestion de Projet & Maîtrise d\'Œuvre', aliases: ['gestion de projet', 'gestion de projets', 'maîtrise d\'œuvre', 'conduite de projet', 'pilotage de projet', 'pilotage de projets'] },
  { name: 'Gestion de Chantier & Travaux', aliases: ['gestion de chantier', 'conduite de travaux', 'suivi de chantier', '=OPC'] },
  { name: 'AutoCAD & Conception DAO/CAO', aliases: ['autocad', '=CAO', '=DAO', 'solidworks', 'catia', 'revit', '=BIM'] },
  { name: 'HSE & Sécurité au Travail', aliases: ['=HSE', 'sécurité au travail', 'qualité sécurité environnement', 'qse', 'iso 9001', 'iso 14001'] },
  { name: 'Lean Manufacturing & Amélioration Continue', aliases: ['lean manufacturing', 'amélioration continue', '=5S', 'six sigma', 'kaizen'] },

  // --- Hôtellerie, Restauration & Tourisme ---
  { name: 'Accueil & Réception Hôtelière', aliases: ['réception hôtelière', 'front desk', 'conciergerie', 'réceptionniste'] },
  { name: 'Logiciels Hôteliers (Opera PMS)', aliases: ['opera pms', 'logiciel hôtelier', '=PMS'] },
  { name: 'Management de la Restauration', aliases: ['haccp', 'art de la table', 'gestion de salle', 'restauration commerciale', 'restauration collective'] },
  { name: 'Gestion des Réservations & Yield Management', aliases: ['yield management', 'revenue management', 'gestion des réservations', '=OTA', 'booking\\.com'] },

  // --- Design, Graphisme & UI/UX ---
  { name: 'Figma & UI/UX Design', aliases: ['figma', 'ui/ux', 'ux design', 'ui design', 'prototypage', 'wireframing', 'design system'] },
  { name: 'Suite Adobe (Photoshop, Illustrator, InDesign)', aliases: ['adobe photoshop', 'photoshop', 'illustrator', 'indesign', 'suite adobe'] },
  { name: 'Direction Artistique & Charte Graphique', aliases: ['direction artistique', 'charte graphique', 'identité visuelle'] },
  { name: 'Motion Design & Montage', aliases: ['motion design', 'after effects', 'premiere pro', 'montage vidéo'] },

  // --- Administration, Secrétariat & Support ---
  { name: 'Gestion Administrative', aliases: ['gestion administrative', 'assistanat', 'secrétariat', 'rédaction administrative'] },
  { name: 'Pack Office (Word, PowerPoint, Excel)', aliases: ['pack office', '=Word', 'powerpoint', 'bureautique', 'microsoft office', 'suite office'] },
  { name: 'Organisation & Gestion d\'Agenda', aliases: ['gestion d\'agenda', 'organisation de réunions', 'organisation des déplacements', 'notes de frais'] },
  { name: 'Accueil Téléphonique & Physique', aliases: ['accueil téléphonique', 'standard téléphonique', 'accueil physique', 'relation usagers'] },

  // --- Informatique, Tech & Data ---
  { name: 'TypeScript', aliases: ['typescript'] },
  { name: 'JavaScript', aliases: ['javascript', '=JS', 'es6', 'esnext'] },
  { name: 'Python', aliases: ['python'] },
  { name: 'Java', aliases: ['java'] },
  { name: 'C# / .NET', aliases: ['c#', 'csharp', '\\.net', 'dotnet'] },
  { name: 'C / C++', aliases: ['c\\+\\+', '=C(?![\'’])', '=C/C\\+\\+'] },
  { name: 'PHP', aliases: ['php'] },
  { name: 'Go', aliases: ['golang', '=Go'] },
  { name: 'SQL', aliases: ['sql'] },
  { name: 'React', aliases: ['react', 'react\\.js', 'reactjs'] },
  { name: 'Next.js', aliases: ['next\\.js', 'nextjs'] },
  { name: 'Vue.js / Nuxt', aliases: ['=Vue(?![\'’])', 'vue\\.js', 'vuejs', 'vue ?3', 'nuxt'] },
  { name: 'Angular', aliases: ['angular'] },
  { name: 'Node.js', aliases: ['=Node', 'node\\.js', 'nodejs'] },
  { name: 'Spring Boot', aliases: ['spring boot', '=Spring'] },
  { name: 'PostgreSQL & Bases de Données', aliases: ['postgresql', 'postgres', 'mysql', 'mongodb', 'redis'] },
  { name: 'Docker & Kubernetes', aliases: ['docker', 'kubernetes', 'k8s'] },
  { name: 'Cloud (AWS, GCP, Azure)', aliases: ['aws', 'gcp', 'azure', 'cloud computing', 'google cloud', 'cloud public'] },
  { name: 'Git & CI/CD', aliases: ['git', 'github', 'gitlab', 'ci/cd'] },
  { name: 'IA & Machine Learning', aliases: ['=IA', 'intelligence artificielle', 'machine learning', '=LLM', 'deep learning', 'ia générative'] },
  { name: 'Méthodologie Agile / Scrum', aliases: ['agile', 'scrum', 'kanban', 'jira'] }
];

/** Nom de groupe (« Docker & Kubernetes », « Suite Adobe (Photoshop, …) ») : il couvre plusieurs outils distincts. */
const isGroupName = (name: string) => /[&(),]|\s\/\s/.test(name);

/** Libellé lisible d'un terme trouvé tel quel dans le texte (« docker » → « Docker », « aws » → « AWS »). */
function displayTerm(found: string): string {
  const t = found.trim();
  if (t !== t.toLowerCase()) return t; // casse d'origine conservée (« MySQL », « GitLab »)
  if ((t.length <= 4 || /^[a-z]{2,4}\/[a-z]{2,4}$/.test(t)) && !/\s/.test(t)) return t.toUpperCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Compétences reconnues dans un texte.
 * - par défaut (offres, contrôles) : nom du catalogue, éventuellement collectif (« Docker & Kubernetes ») ;
 * - `precise` (profil du candidat) : pour un nom collectif, seuls les outils réellement écrits dans le texte
 *   (« Docker » et non « Docker & Kubernetes »), pour ne rien ajouter au CV.
 */
export function extractTechnologies(text: string, options: { precise?: boolean } = {}): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();

  for (const item of UNIVERSAL_SKILLS_CATALOG) {
    const precise = options.precise && isGroupName(item.name);
    for (const rawAlias of item.aliases) {
      // « =XXX » : alias sensible à la casse (sigles ambigus : C, Go, Vue, IA, Word…)
      const strict = rawAlias.startsWith('=');
      const alias = strict ? rawAlias.slice(1) : rawAlias;
      try {
        const regex = new RegExp(`(^|[^a-zA-Z0-9_#+À-ÿ])(${alias})([^a-zA-Z0-9_#+À-ÿ'’]|$)`, strict ? '' : 'i');
        const m = text.match(regex);
        if (m) {
          if (!precise) {
            found.push(item.name);
            break;
          }
          found.push(displayTerm(m[2]));
        }
      } catch {
        if (!strict && lower.includes(alias.toLowerCase())) {
          if (!precise) {
            found.push(item.name);
            break;
          }
          const i = lower.indexOf(alias.toLowerCase());
          found.push(displayTerm(text.slice(i, i + alias.length)));
        }
      }
    }
  }

  // Dédoublonnage insensible à la casse
  const seen = new Set<string>();
  return found.filter(f => {
    const k = f.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 3. Semantic CV Parser (Deterministic Heuristic Engine)
// ---------------------------------------------------------------------------

export function parseCvSemantically(rawText: string): ExtractedCvData {
  const text = (rawText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // 3.1 Contact details extraction
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const email = emailMatch ? emailMatch[0].toLowerCase() : '';

  const phoneMatch = text.match(/(?:(?:\+|00)33[\s.-]?\(0\)[\s.-]?|0)[1-9](?:[\s.-]?\d{2}){4}/) 
    // International : +XX suivi de 8 à 12 chiffres (évite de prendre des suites d'années pour un numéro)
    || text.match(/\+\d{2,3}[\s.-]?\(?\d\)?(?:[\s.-]?\d{2}){4,5}/);
  const phone = phoneMatch ? phoneMatch[0].replace(/[\s.-]+/g, ' ').trim() : '';

  const linkedinMatch = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([a-zA-Z0-9_-]+)/i);
  const linkedinUrl = linkedinMatch 
    ? (linkedinMatch[0].startsWith('http') ? linkedinMatch[0] : `https://${linkedinMatch[0]}`) 
    : '';

  const githubMatch = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9_-]+)/i);
  const githubUrl = githubMatch && !githubMatch[0].includes('/repos') 
    ? (githubMatch[0].startsWith('http') ? githubMatch[0] : `https://${githubMatch[0]}`) 
    : '';

  const portfolioMatch = text.match(/https?:\/\/(?!www\.linkedin|www\.github|linkedin\.com|github\.com)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?/i);
  const portfolioUrl = portfolioMatch ? portfolioMatch[0] : '';

  // 3.2 Location
  const cities = [
    'Paris', 'Lyon', 'Marseille', 'Toulouse', 'Lille', 'Bordeaux', 'Nantes',
    'Strasbourg', 'Rennes', 'Montpellier', 'Nice', 'Grenoble', 'Toulon',
    'Angers', 'Dijon', 'Brest', 'Le Mans', 'Aix-en-Provence', 'Tours',
    'Clermont-Ferrand', 'Rouen', 'Metz', 'Nancy', 'Orléans', 'Caen',
    'Boulogne-Billancourt', 'Saint-Denis', 'Argenteuil', 'Montreuil', 'Versailles',
    'Avignon', 'Nîmes', 'Arles', 'Orange', 'Carpentras', 'Cavaillon', 'Valence', 'Perpignan',
    'Limoges', 'Poitiers', 'Reims', 'Amiens', 'Besançon', 'Pau', 'Bayonne', 'La Rochelle', 'Annecy'
  ];
  let location = '';
  for (const c of cities) {
    const cityRegex = new RegExp(`\\b${c}\\b`, 'i');
    if (cityRegex.test(text)) {
      location = `${c}, France`;
      break;
    }
  }
  // Code postal : cherché uniquement dans l'en-tête du CV (sinon « 15000 utilisateurs » devenait une ville)
  const headerText = lines.slice(0, 10).join('\n');
  const postalCodeMatch = headerText.match(/\b(0[1-9]|[1-8]\d|9[0-8])\d{3}\s+([A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+(?:[ -][A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+)*)/);
  if (postalCodeMatch) {
    location = `${postalCodeMatch[2].trim()} (${postalCodeMatch[1]})`;
  }

  // 3.3 Name Extraction
  let fullName = '';
  const headerLines = lines.slice(0, 8);
  for (const line of headerLines) {
    // Skip obvious non-names
    if (line.includes('@') || line.includes('http') || line.match(/\d{4}/) || line.length < 3 || line.length > 45) continue;
    if (line.match(/(?:curriculum|vitae|développeur|ingénieur|alternant|stage|étudiant|profil|contact|adresse|permis)/i)) continue;

    // A valid name usually has 2-4 capitalized words
    const words = line.split(/\s+/).filter(w => w.length > 1);
    if (words.length >= 2 && words.length <= 4) {
      const isCapitalized = words.every(w => /^[A-ZÀ-ÿ]/.test(w));
      if (isCapitalized) {
        fullName = words.map(w => w.length <= 2 ? w.toUpperCase() : (w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
        break;
      }
    }
  }

  if (!fullName && email) {
    const userPart = email.split('@')[0].replace(/[0-9._-]+/g, ' ').trim();
    if (userPart.length > 2) {
      fullName = userPart.split(' ')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
    }
  }

  // 3.4 Title / Headline Extraction
  let title = '';
  const titleKeywords = [
    // Ressources Humaines & Recrutement
    'Responsable Ressources Humaines', 'Responsable RH', 'Chargé de Recrutement', 'Chargée de Recrutement',
    'Talent Acquisition Specialist', 'Gestionnaire de Paie', 'Assistant RH', 'Assistante RH',
    'Consultant RH', 'Chargé de Mission RH', 'HR Business Partner', 'HRBP',

    // Marketing & Communication
    'Chef de Projet Marketing', 'Chargé de Communication', 'Chargée de Communication',
    'Responsable Marketing', 'Responsable Communication', 'Community Manager', 'Social Media Manager',
    'Traffic Manager', 'Growth Marketer', 'Content Manager', 'Chef de Produit Marketing',

    // Finance, Audit & Comptabilité
    'Analyste Financier', 'Contrôleur de Gestion', 'Comptable Général', 'Comptable Unique',
    'Collaborateur Comptable', 'Auditeur Financier', 'Gestionnaire Financier', 'Assistant Comptable',
    'Directeur Administratif et Financier', 'DAF', 'Trésorier',

    // Commerce, Vente & Business Development
    'Business Developer', 'Commercial B2B', 'Commerciale B2B', 'Ingénieur Commercial',
    'Responsable Commercial', 'Account Executive', 'Chargé d\'Affaires', 'Chargée d\'Affaires',
    'Key Account Manager', 'Conseiller Commercial', 'Technico-Commercial',

    // Achats & Logistique
    'Acheteur', 'Acheteuse', 'Responsable Logistique', 'Supply Chain Manager',
    'Gestionnaire de Stocks', 'Approvisionneur', 'Coordinateur Logistique',

    // Juridique & Droit
    'Juriste d\'Entreprise', 'Juriste Droit Social', 'Juriste Droit des Affaires',
    'Responsable Juridique', 'Compliance Officer', 'Chargé de Conformité',

    // Santé & Pharmacie
    'Attaché de Recherche Clinique', 'ARC', 'Chargé d\'Affaires Réglementaires',
    'Pharmacien', 'Pharmacienne', 'Responsable Qualité Santé', 'Biologiste',

    // Ingénierie & BTP
    'Ingénieur BTP', 'Conducteur de Travaux', 'Conductrice de Travaux', 'Chef de Chantier',
    'Ingénieur Mécanique', 'Ingénieur Qualité HSE', 'Ingénieur Travaux', 'Ingénieur Généraliste',

    // Hôtellerie & Tourisme
    'Responsable Réception', 'Directeur d\'Hôtel', 'Gouvernant Général', 'Chef de Rang',
    'Coordinateur Événementiel', 'Conseiller Voyages',

    // Design & Création
    'UI/UX Designer', 'Product Designer', 'Directeur Artistique', 'Graphiste',
    'Webdesigner', 'Motion Designer', 'Designer Graphique',

    // Administration & Support
    'Assistant de Direction', 'Assistante de Direction', 'Office Manager',
    'Assistant Administratif', 'Assistante Administrative', 'Secrétaire',

    // Informatique & Tech
    'Développeur Full Stack', 'Développeur Fullstack', 'Développeur Frontend', 'Développeur Front-end',
    'Développeur Backend', 'Développeur Back-end', 'Développeur Web', 'Développeur Mobile',
    'Ingénieur Logiciel', 'Software Engineer', 'Data Engineer', 'Data Scientist', 'Data Analyst',
    'DevOps Engineer', 'Lead Développeur', 'Tech Lead', 'Architecte Solution',

    // Formats Universels & Alternance / Stage
    'Alternant', 'Alternante', 'Stagiaire', 'Étudiant', 'Étudiante'
  ];

  for (const line of headerLines) {
    for (const t of titleKeywords) {
      if (line.toLowerCase().includes(t.toLowerCase())) {
        title = line.length < 60 ? line : t;
        break;
      }
    }
    if (title) break;
  }

  if (!title) {
    for (const t of titleKeywords) {
      if (text.toLowerCase().includes(t.toLowerCase())) {
        title = t;
        break;
      }
    }
  }

  // Smart neutral fallback: use first short non-contact line or neutral universal title
  if (!title) {
    const candidateLine = headerLines.find(l => l.length >= 4 && l.length <= 50 && !l.match(/@|\.com|\.fr|\+33|\d{5}/));
    title = candidateLine || '';
  }

  // 3.5 Section Slicing
  // Un titre de section doit correspondre ENTIÈREMENT au motif (éventuellement « X & Y ») :
  // « Stage communication chez Mairie d'Arles » n'est plus pris pour un titre de section.
  const SECTION_END = String.raw`(?:\s*(?:&|et|and|/)\s*[A-Za-zÀ-ÿ' ]{2,30})?$`;
  const sec = (body: string) => new RegExp(`^(?:${body})${SECTION_END}`, 'i');
  const sectionKeywords: Record<string, RegExp> = {
    profile: sec(String.raw`profil(?:\s+professionnel)?|à propos(?:\s+de moi)?|resume|résumé|sommaire|objectif|bio|summary|about me`),
    experience: sec(String.raw`expériences?(?:\s+professionnelles?)?|experiences?(?:\s+professionnelles?)?|parcours(?:\s+professionnel)?|work\s+experience|stages?(?:\s+et\s+alternances?)?|employment\s+history`),
    education: sec(String.raw`formations?|diplômes?|diplomes?|études?|etudes?|cursus|education|parcours\s+académique|qualifications?|certifications?`),
    skills: sec(String.raw`compétences?(?:\s+(?:techniques?|clés|professionnelles?))?|competences?|skills|hard\s+skills|technologies|stack(?:\s+technique)?|outils|savoir-faire`),
    projects: sec(String.raw`projets?(?:\s+(?:personnels?|réalisés?|académiques?))?|réalisations?|projects|portfolio`),
    languages: sec(String.raw`langues?(?:\s+vivantes?)?|languages`)
  };

  type SectionType = 'header' | 'profile' | 'experience' | 'education' | 'skills' | 'projects' | 'languages';
  const sections: { type: SectionType; lines: string[] }[] = [{ type: 'header', lines: [] }];

  for (const line of lines) {
    let matchedType: SectionType | null = null;
    const cleanHeader = line.replace(/^[\W_]+/, '').replace(/[\W_]+$/, '').trim();

    if (cleanHeader.length <= 45) {
      for (const [secName, regex] of Object.entries(sectionKeywords)) {
        if (regex.test(cleanHeader)) {
          matchedType = secName as SectionType;
          break;
        }
      }
    }

    if (matchedType) {
      sections.push({ type: matchedType, lines: [] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }

  // 3.6 Summary / Bio
  let summary = '';
  const profileSec = sections.find(s => s.type === 'profile');
  if (profileSec && profileSec.lines.length > 0) {
    summary = profileSec.lines.join(' ').slice(0, 450);
  }
  if (!summary) {
    // Look for intro text in header
    const headerTexts = sections[0].lines.filter(l => 
      !l.includes('@') && !l.includes('http') && l.length > 40 && !l.match(/\d{4}/)
    );
    if (headerTexts.length > 0) {
      summary = headerTexts.join(' ').slice(0, 400);
    }
  }
  // Pas d'accroche inventée : si le CV n'en contient pas, le champ reste vide.

  // 3.7 Skills Extraction
  const allDetectedSkills = extractTechnologies(text, { precise: true });
  const skillsSec = sections.find(s => s.type === 'skills');
  const sectionSkills: string[] = [];
  if (skillsSec) {
    for (const l of skillsSec.lines) {
      // Extract from lists separated by commas, bullets or pipes
      const parts = l.replace(/^[-•*–>|]+/, '')
        // « / » ne sépare que s'il est entouré d'espaces : « CI/CD », « UI/UX » restent entiers
        .split(/[,;|•·]+|\s\/\s/)
        .map(p => p.trim())
        .filter(p => p.length >= 2 && p.length <= 35 && !p.includes(':'));
      for (const p of parts) {
        if (!sectionSkills.includes(p)) sectionSkills.push(p);
      }
    }
  }

  const combinedSkills = Array.from(new Set([...allDetectedSkills, ...sectionSkills]))
    .filter(s => s.length >= 2 && s.length <= 35);
  // Pas de compétences par défaut : liste vide si rien n'est détecté. Dédoublonnage insensible à la casse.
  const seenSkills = new Set<string>();
  const finalSkills = combinedSkills.filter(sk => {
    const k = sk.toLowerCase();
    if (seenSkills.has(k)) return false;
    seenSkills.add(k);
    return true;
  });

  // 3.8 Experiences Extraction
  const expSec = sections.find(s => s.type === 'experience');
  const experiences: Experience[] = [];

  if (expSec && expSec.lines.length > 0) {
    const expLines = expSec.lines;
    const datePattern = /(?:(?:janv|févr|fevr|mars|avr|mai|juin|juil|août|aout|sept|oct|nov|déc|dec)[a-zA-Z.]*\s+)?(?:\d{4}|\d{2}\/\d{4})\s*(?:[-–—àau\s]+|to\s+)(?:(?:janv|févr|fevr|mars|avr|mai|juin|juil|août|aout|sept|oct|nov|déc|dec)[a-zA-Z.]*\s+)?(?:\d{4}|\d{2}\/\d{4}|présent|present|actuel|aujourd'hui|en cours)|depuis\s+(?:\d{4}|\d{2}\/\d{4})/i;

    let currentExp: Partial<Experience> & { rawLines: string[] } | null = null;

    for (let i = 0; i < expLines.length; i++) {
      const line = expLines[i];
      const hasDate = datePattern.test(line);

      if (hasDate) {
        if (currentExp) {
          experiences.push(finalizeExperience(currentExp, experiences.length));
        }

        const dateMatch = line.match(datePattern);
        const dateStr = dateMatch ? dateMatch[0].trim() : '';
        const isCurrent = /présent|present|actuel|aujourd'hui|en cours/i.test(dateStr);
        const dates = dateStr.split(/\s*(?:[-–—]|à|\bau\b|\bto\b)\s*/i).map(s => s.trim()).filter(Boolean);

        let expTitle = '';
        let company = '';
        let expLoc = '';

        if (line.includes('|')) {
          const pipeParts = line.split('|').map(p => p.trim()).filter(Boolean);
          const nonDateParts = pipeParts.filter(p => !datePattern.test(p));
          if (nonDateParts.length >= 1) {
            expTitle = nonDateParts[0];
            // « Poste - Entreprise | dates »
            if (nonDateParts.length === 1 && /\s[-–—]\s/.test(expTitle)) {
              const [t, c] = expTitle.split(/\s+[-–—]\s+/);
              expTitle = t.trim();
              company = (c || '').trim();
            }
          }
          if (nonDateParts.length >= 2) {
            const companyAndLoc = nonDateParts[1];
            if (companyAndLoc.includes(',')) {
              const [c, l] = companyAndLoc.split(',').map(s => s.trim());
              company = c;
              expLoc = l;
            } else {
              company = companyAndLoc;
            }
          }
        } else {
          const restOfLine = line.replace(datePattern, '').replace(/^[-–—|:,•\s]+/, '').replace(/[-–—|:,•\s]+$/, '').trim();
          if (/chez|\bat\b/i.test(restOfLine)) {
            const parts = restOfLine.split(/\s+(?:chez|at)\s+/i);
            expTitle = parts[0]?.trim();
            company = parts[1]?.trim();
          } else if (/\s[-–—]\s/.test(restOfLine)) {
            const parts = restOfLine.split(/\s+[-–—]\s+/);
            expTitle = parts[0]?.trim();
            company = parts[1]?.trim();
          } else {
            expTitle = restOfLine || (i > 0 && expLines[i - 1].length < 60 ? expLines[i - 1] : title);
          }
        }

        currentExp = {
          title: expTitle || title || 'Poste',
          company: company.trim(),
          location: expLoc,
          startDate: dates[0] || '',
          endDate: isCurrent ? 'Présent' : (dates[1] || ''),
          current: isCurrent,
          bullets: [],
          technologies: [],
          rawLines: []
        };
      } else if (currentExp) {
        currentExp.rawLines.push(line);
      }
    }

    if (currentExp) {
      experiences.push(finalizeExperience(currentExp, experiences.length));
    }
  }

  // Strict Zero-Hallucination: if no formatted experience found, capture raw text lines from experience section
  if (experiences.length === 0 && expSec && expSec.lines.length > 0) {
    const rawBullets = expSec.lines
      .map(l => l.replace(/^[-•*–>\s]+/, '').trim())
      .filter(l => l.length > 10 && !l.match(/^(?:expériences|parcours)/i));
    if (rawBullets.length > 0) {
      experiences.push({
        id: `exp-real-1`,
        title: title || 'Poste',
        company: '',
        location: '',
        startDate: '',
        endDate: '',
        current: false,
        bullets: rawBullets.slice(0, 5),
        technologies: extractTechnologies(rawBullets.join(' '), { precise: true }).slice(0, 5)
      });
    }
  }

  // 3.9 Education Extraction
  const eduSec = sections.find(s => s.type === 'education');
  const education: Education[] = [];

  if (eduSec && eduSec.lines.length > 0) {
    const eduLines = eduSec.lines;
    const yearPattern = /\b(19\d{2}|20\d{2})\s*(?:[-–—àa]\s*(19\d{2}|20\d{2}|présent|en cours))?\b/i;

    for (const l of eduLines) {
      const yearMatch = l.match(yearPattern);
      const degreeMatch = l.match(/(?:master|licence|but|bts|dut|bachelor|ingénieur|ingenieur|doctorat|baccalauréat|bac\s*\+\s*\d|cpge|deust|titre\s+rncp)/i);

      if (degreeMatch || yearMatch) {
        const year = yearMatch ? yearMatch[0].trim() : '';
        const cleanLine = l.replace(yearPattern, '').replace(/^[-–—|:,•\s]+/, '').trim();
        
        let degree = cleanLine;
        let institution = '';

        if (/[|–—]|\s-\s/.test(cleanLine)) {
          const parts = cleanLine.split(/[|–—]|\s+-\s+/).map(p => p.trim()).filter(Boolean);
          if (parts.length >= 2) {
            degree = parts[0];
            institution = parts[1];
          }
        } else {
          const instMatch = cleanLine.match(/(?:université|universite|école|ecole|iut|faculté|institut|lycée|insa|polytech|epita|epitech|sorbonne)/i);
          const comma = cleanLine.indexOf(',');
          if (instMatch && comma > 0 && comma < (instMatch.index ?? 0)) {
            // « BTS SIO, Lycée Mistral » : diplôme complet puis établissement
            degree = cleanLine.slice(0, comma).trim();
            institution = cleanLine.slice(comma + 1).trim();
          } else if (instMatch) {
            institution = cleanLine;
            degree = degreeMatch ? degreeMatch[0].toUpperCase() : 'Diplôme';
          }
        }

        education.push({
          id: `edu-${Date.now()}-${education.length + 1}`,
          degree: degree || 'Formation',
          institution: institution || '',
          year: year,
          details: ''
        });
      }
    }
  }

  // Pas de formation inventée si aucune n'est détectée.

  // 3.10 Projects Extraction
  const projSec = sections.find(s => s.type === 'projects');
  const projects: Project[] = [];

  if (projSec && projSec.lines.length > 0) {
    let projName = '';
    let projDesc = '';
    for (const l of projSec.lines) {
      const isBullet = /^[-•*–>]/.test(l);
      if (!isBullet && l.length > 2 && l.length < 50 && !l.includes('http')) {
        if (projName) {
          projects.push({
            id: `proj-${projects.length + 1}`,
            name: projName,
            description: projDesc || '',
            technologies: extractTechnologies(`${projName} ${projDesc}`, { precise: true }).slice(0, 4)
          });
        }
        projName = l.replace(/^[:\s-]+/, '').trim();
        projDesc = '';
      } else {
        projDesc += (projDesc ? ' ' : '') + l.replace(/^[-•*–>\s]+/, '').trim();
      }
    }
    if (projName) {
      projects.push({
        id: `proj-${projects.length + 1}`,
        name: projName,
        description: projDesc || '',
        technologies: extractTechnologies(`${projName} ${projDesc}`, { precise: true }).slice(0, 4)
      });
    }
  }

  // 3.11 Languages
  const languages: string[] = [];
  const langSec = sections.find(s => s.type === 'languages');
  // Chaque langue garde SON niveau tel qu'écrit dans le CV (avant : le niveau le plus haut
  // de la section était appliqué à toutes les langues). Sans section Langues, on ne déduit rien.
  const langPatterns = [
    { name: 'Français', regex: /français|francais|french/i },
    { name: 'Anglais', regex: /anglais|english/i },
    { name: 'Arabe', regex: /arabe|arabic/i },
    { name: 'Espagnol', regex: /espagnol|spanish/i },
    { name: 'Allemand', regex: /allemand|german/i },
    { name: 'Italien', regex: /italien|italian/i },
    { name: 'Portugais', regex: /portugais|portuguese/i },
    { name: 'Chinois', regex: /chinois|mandarin|chinese/i }
  ];

  if (langSec) {
    const segments = langSec.lines.join('\n').split(/[\n,;|•·]+/).map(x => x.trim()).filter(Boolean);
    for (const lp of langPatterns) {
      const seg = segments.find(x => lp.regex.test(x));
      if (!seg) continue;
      const level = seg.replace(lp.regex, '').replace(/^[\s:()\-–]+|[\s()]+$/g, '').trim();
      languages.push(level ? `${lp.name} (${level})` : lp.name);
    }
  }

  return {
    fullName,
    email,
    phone,
    title,
    location,
    linkedinUrl,
    githubUrl,
    portfolioUrl,
    summary,
    skills: finalSkills,
    experiences,
    education,
    projects,
    languages,
    targetRoles: [title].filter(Boolean)
  };
}

function finalizeExperience(rawExp: Partial<Experience> & { rawLines: string[] }, index: number): Experience {
  const bullets: string[] = [];
  const fullContent = rawExp.rawLines.join(' ');

  for (const line of rawExp.rawLines) {
    const clean = line.replace(/^[-•*–>\s]+/, '').trim();
    if (clean.length > 5) {
      bullets.push(clean);
    }
  }

  const techDetected = extractTechnologies(fullContent, { precise: true });

  return {
    id: `exp-${Date.now()}-${index + 1}`,
    title: rawExp.title?.trim() || 'Poste',
    company: rawExp.company ? rawExp.company.trim() : '',
    location: rawExp.location ? rawExp.location.trim() : '',
    startDate: rawExp.startDate ? rawExp.startDate.trim() : '',
    endDate: rawExp.endDate ? rawExp.endDate.trim() : '',
    current: !!rawExp.current,
    bullets: bullets.slice(0, 5),
    technologies: techDetected.slice(0, 5)
  };
}

/** Vrai si l'analyse n'a rien trouvé d'exploitable (texte illisible, binaire…). */
export function isParsedCvEmpty(p: ExtractedCvData): boolean {
  return !p.email && !p.phone && p.skills.length === 0 && p.experiences.length === 0 && p.education.length === 0;
}
