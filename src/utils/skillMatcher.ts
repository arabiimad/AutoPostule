/**
 * Source unique du calcul de compatibilité candidat / offre.
 * Utilisée par le Radar (affichage + filtre), le Studio LaTeX, l'agent et le serveur.
 *
 * Règles :
 * - comparaison insensible à la casse et aux accents, avec limites de mots
 *   (évite 'Java' ⇢ 'JavaScript', 'R' ⇢ tout) ;
 * - une compétence requise est validée si le candidat la possède telle quelle,
 *   ou si l'une de ses compétences la contient ('Excel avancé' couvre 'Excel') ;
 * - le sens inverse (compétence candidat plus courte que la compétence requise)
 *   n'est accepté que si elle en couvre l'essentiel : 'Gestion' ne valide plus
 *   'Gestion prestataires' ;
 * - quelques synonymes courants sont reconnus ;
 * - score = part des compétences requises couvertes (0 à 100), sans plancher artificiel.
 */

const SYNONYMS: string[][] = [
  ['pack office', 'microsoft office', 'office 365', 'suite office'],
  ['excel', 'microsoft excel'],
  ['anglais', 'english'],
  ['gestion de projet', 'project management', 'pilotage de projet'],
  ['agile', 'methodologies agiles', 'methodologie agile', 'methode agile', 'methodes agiles'],
  ['javascript', 'js'],
  ['typescript', 'ts'],
  ['postgresql', 'postgres'],
  ['ci/cd', 'integration continue'],
  ['api rest', 'rest api', 'api restful']
];

export function normalizeSkill(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function containsWord(text: string, term: string): boolean {
  if (!text || !term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^a-z0-9_#+])${escaped}([^a-z0-9_#+]|$)`, 'i');
  return pattern.test(text);
}

/** Conservé pour compatibilité : test « tech présente dans le texte » avec limites de mots. */
export function matchesTech(text: string, tech: string): boolean {
  return containsWord(normalizeSkill(text), normalizeSkill(tech));
}

function variantsOf(skill: string): string[] {
  const n = normalizeSkill(skill);
  // Égalité stricte : « Node.js » ne doit pas hériter des synonymes de « js »
  const group = SYNONYMS.find(g => g.includes(n));
  return group ? Array.from(new Set([n, ...group])) : [n];
}

/**
 * Découpe une compétence composée en alternatives :
 * « C# / .NET » → [« C# / .NET », « C# », « .NET »] ;
 * « Suite Adobe (Photoshop, Illustrator) » → [..., « Suite Adobe », « Photoshop », « Illustrator »].
 * Posséder l'une des alternatives suffit.
 */
export function skillAlternatives(requiredSkill: string): string[] {
  const full = requiredSkill.trim();
  const parts = full
    .split(/\s+\/\s+|\s+&\s+|\s+et\s+|[(),;]/i)
    .map(p => p.trim())
    .filter(p => p.length >= 2);
  return Array.from(new Set([full, ...parts]));
}

/** Le candidat couvre-t-il cette compétence requise ? */
export function candidateHasSkill(candidateSkills: string[], requiredSkill: string): boolean {
  if (!Array.isArray(candidateSkills) || !requiredSkill) return false;
  const alternatives = skillAlternatives(requiredSkill);
  if (alternatives.length > 1) {
    return alternatives.some(alt => matchesOne(candidateSkills, alt));
  }
  return matchesOne(candidateSkills, requiredSkill);
}

function matchesOne(candidateSkills: string[], requiredSkill: string): boolean {
  const reqVariants = variantsOf(requiredSkill);
  const reqNorm = normalizeSkill(requiredSkill);

  return candidateSkills.some(raw => {
    const cand = normalizeSkill(raw);
    if (!cand) return false;
    // 1. Le candidat possède la compétence (ou un synonyme), éventuellement dans une formulation plus large
    if (reqVariants.some(v => cand === v || containsWord(cand, v))) return true;
    // 2. Formulation candidat plus courte : acceptée seulement si elle couvre l'essentiel de la compétence requise
    if (containsWord(reqNorm, cand) && cand.length >= reqNorm.length * 0.6) return true;
    return false;
  });
}

export interface CandidateMatch {
  /** 0–100, ou null si l'offre ne liste aucune compétence (non évaluable). */
  score: number | null;
  matchedKeywords: string[];
  missingKeywords: string[];
}

export function calculateCandidateMatch(candidateSkills: string[], jobSkillsRequired: string[]): CandidateMatch {
  const required = Array.isArray(jobSkillsRequired) ? jobSkillsRequired.filter(Boolean) : [];
  if (required.length === 0) {
    return { score: null, matchedKeywords: [], missingKeywords: [] };
  }
  const skills = Array.isArray(candidateSkills) ? candidateSkills : [];

  const matchedKeywords: string[] = [];
  const missingKeywords: string[] = [];
  for (const req of required) {
    (candidateHasSkill(skills, req) ? matchedKeywords : missingKeywords).push(req);
  }

  return {
    score: Math.round((matchedKeywords.length / required.length) * 100),
    matchedKeywords,
    missingKeywords
  };
}

/** Score utilisable pour trier / filtrer (null ⇒ 0). */
export function scoreValue(match: CandidateMatch): number {
  return match.score ?? 0;
}

// ---------------------------------------------------------------------------
// Proximité métier : l'offre est-elle dans le champ du parcours du candidat ?
// ---------------------------------------------------------------------------
const TITLE_STOPWORDS = new Set([
  'h/f', 'f/h', 'hf', 'fh', 'homme', 'femme', 'poste', 'offre', 'emploi', 'alternance', 'stage', 'stagiaire', 'apprenti',
  'apprentie', 'contrat', 'cdi', 'cdd', 'interim', 'mission', 'junior', 'senior', 'confirme', 'confirmee', 'debutant',
  'charge', 'chargee', 'assistant', 'assistante', 'responsable', 'agent', 'agente', 'chef', 'adjoint', 'adjointe',
  'candidature', 'spontanee', 'pour', 'avec', 'dans', 'des', 'les', 'une', 'aux', 'sur', 'niveau'
]);

/** Racines significatives d'un intitulé (sans accents, sans mots génériques ni niveaux « N3 »). */
export function titleStems(text: string): string[] {
  return Array.from(new Set(
    String(text || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length >= 4 && !TITLE_STOPWORDS.has(w) && !/^n\d$/.test(w))
      .map((w) => w.slice(0, 6))
  ));
}

/**
 * Vrai si l'offre semble hors du parcours : aucune compétence commune ET aucun mot de métier
 * commun entre l'intitulé de l'offre et le titre, les métiers visés ou les postes occupés.
 * Sert à prévenir l'utilisateur et à interdire à l'IA de « maquiller » le titre du CV.
 */
export function isFarFromProfile(
  candidate: { title?: string; targetRoles?: string[]; skills?: string[]; experiences?: { title?: string }[] } | null | undefined,
  job: { title?: string; skillsRequired?: string[] } | null | undefined
): boolean {
  const jobStems = titleStems(String(job?.title || '').replace(/^Candidature spontanée — /, ''));
  if (!jobStems.length) return false;
  const profileText = [candidate?.title, ...(candidate?.targetRoles || []), ...(candidate?.experiences || []).map((e) => e?.title)].join(' ');
  const profileStems = new Set(titleStems(profileText));
  if (jobStems.some((s) => profileStems.has(s))) return false;
  const match = calculateCandidateMatch(candidate?.skills || [], job?.skillsRequired || []);
  return !match.matchedKeywords.length;
}

// ---------------------------------------------------------------------------
// Adéquation offre ↔ profil : niveau expliqué (fort / moyen / faible), jamais un faux pourcentage précis
// ---------------------------------------------------------------------------
export type FitLevel = 'forte' | 'moyenne' | 'faible';

export interface JobFit extends CandidateMatch {
  /** null : pas assez d'informations pour juger honnêtement. */
  level: FitLevel | null;
  /** Raisons affichées à l'utilisateur (2-3 puces). */
  reasons: string[];
  /** Valeur interne 0-100 pour trier (non affichée). */
  rank: number;
}

type FitProfile = { title?: string; targetRoles?: string[]; skills?: string[]; experiences?: { title?: string }[]; preferredContracts?: string[] };
type FitJob = { title?: string; skillsRequired?: string[]; contractType?: string; isSpontaneous?: boolean };

export function assessFit(profile: FitProfile | null | undefined, job: FitJob | null | undefined): JobFit {
  const match = calculateCandidateMatch(profile?.skills || [], job?.skillsRequired || []);
  const required = match.matchedKeywords.length + match.missingKeywords.length;
  const jobStems = titleStems(String(job?.title || '').replace(/^Candidature spontanée — /, ''));
  const profileRoles = [profile?.title, ...(profile?.targetRoles || []), ...(profile?.experiences || []).map((e) => e?.title)].filter(Boolean) as string[];
  const profileStems = new Set(titleStems(profileRoles.join(' ')));
  const sameField = jobStems.some((s) => profileStems.has(s));
  const hasProfile = profileRoles.length > 0 || (profile?.skills || []).length > 0;

  const reasons: string[] = [];
  if (!hasProfile || !jobStems.length) return { ...match, level: null, reasons, rank: 0 };

  if (sameField) {
    const role = profileRoles.find((r) => titleStems(r).some((s) => jobStems.includes(s)));
    reasons.push(`Métier proche de votre parcours${role ? ` (${role})` : ''}`);
  } else {
    reasons.push('Métier différent de votre parcours');
  }
  if (required >= 2) {
    reasons.push(`${match.matchedKeywords.length} compétence${match.matchedKeywords.length > 1 ? 's' : ''} demandée${match.matchedKeywords.length > 1 ? 's' : ''} sur ${required} dans votre profil`);
  } else if (required === 1) {
    reasons.push('L’offre précise peu de compétences : lisez le descriptif');
  }
  if (job?.contractType && profile?.preferredContracts?.length && !profile.preferredContracts.includes(job.contractType)) {
    reasons.push('Type de contrat différent de vos préférences');
  }

  const skillPart = required >= 2 ? (match.matchedKeywords.length / required) * 45 : match.matchedKeywords.length ? 15 : 0;
  const rank = Math.round((sameField ? 55 : 0) + skillPart);
  // Métier différent et offre peu détaillée : on n'affiche pas de niveau optimiste
  let level: FitLevel | null;
  if (!sameField && required < 2) level = match.matchedKeywords.length ? null : 'faible';
  else level = rank >= 70 ? 'forte' : rank >= 40 ? 'moyenne' : 'faible';
  return { ...match, level, reasons: reasons.slice(0, 3), rank };
}

export const FIT_LABELS: Record<FitLevel, string> = { forte: 'Adéquation forte', moyenne: 'Adéquation moyenne', faible: 'Adéquation faible' };
