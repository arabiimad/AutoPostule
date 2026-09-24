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
