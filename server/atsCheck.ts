/**
 * Outils publics (sans compte, sans IA) :
 *  - vérificateur de CV « compatible ATS » : ce qu'un logiciel de tri des candidatures lit réellement ;
 *  - correspondance CV / offre : mots-clés de l'offre présents ou absents du CV.
 * Analyse déterministe et gratuite : même résultat à chaque essai, aucun coût d'IA, aucune donnée conservée.
 */
import { extractSkillMentions } from "../src/semanticCvParser.ts";
import { candidateHasSkill, normalizeSkill } from "../src/utils/skillMatcher.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface AtsCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** Ce qui a été constaté. */
  detail: string;
  /** Que faire (absent si tout va bien). */
  advice?: string;
}

export interface AtsReport {
  score: number;
  level: "excellent" | "bon" | "à améliorer" | "insuffisant";
  checks: AtsCheck[];
  stats: { words: number; pages: number | null; sections: string[]; skills: string[] };
  /** Début du texte tel qu'un ATS le lit. */
  preview: string;
}

export interface CvInputMeta {
  format: "pdf" | "docx" | "text";
  pages?: number | null;
}

// Poids de chaque contrôle (total 100) : « ok » = tout, « warn » = moitié, « fail » = rien
const WEIGHTS: Record<string, number> = {
  text: 25, characters: 10, contact: 10, sections: 15, dates: 8, length: 8, bullets: 6, skills: 10, layout: 8
};

const SECTION_PATTERNS: { name: string; re: RegExp; required: boolean }[] = [
  { name: "Expérience", re: /(exp[ée]riences?|parcours professionnel|emplois?|work experience|experience)/i, required: true },
  { name: "Formation", re: /(formations?|dipl[ôo]mes?|[ée]tudes|scolarit[ée]|cursus|education)/i, required: true },
  { name: "Compétences", re: /(comp[ée]tences|savoir[- ]faire|skills|aptitudes|atouts|outils)/i, required: true },
  { name: "Langues", re: /(langues|languages)/i, required: false },
  { name: "Profil", re: /(profil|à propos|a propos|r[ée]sum[ée]|objectif|summary)/i, required: false }
];

const BULLET_LINE = /^\s*[•●○▪■◆◦‣∙·\-–—*►➢✓✔]\s+\S/;
const PRIVATE_USE = /[-�]/g;
const LIGATURES = /[ﬀ-ﬆ]/g;
const CID_GLYPHS = /\(cid:\d+\)/g;
// Accent séparé de sa lettre (« D´eveloppeur ») : PDF LaTeX sans \usepackage[T1]{fontenc}, certaines polices
const DETACHED_ACCENT = /([´`ˆ¨˜¸])\s?([A-Za-zıȷ])/g;
const COMBINING: Record<string, string> = { "´": "\u0301", "`": "\u0300", "ˆ": "\u0302", "¨": "\u0308", "˜": "\u0303", "¸": "\u0327" };

/** Recolle les accents séparés, pour analyser le texte tel que le candidat l'a écrit. */
export function repairDetachedAccents(text: string): string {
  return text.replace(DETACHED_ACCENT, (_m, acc: string, letter: string) => (letter === "ı" ? "i" : letter) + COMBINING[acc]).normalize("NFC");
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /(\+\d{1,3}[\s.-]?)?(\(?0\)?[\s.-]?)?[1-9](?:[\s.-]?\d{2}){4}\b|\+\d[\d\s.-]{7,14}\d/;

const words = (text: string) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

/** Titres de section trouvés : ligne courte qui contient le mot-clé. */
export function findSections(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return SECTION_PATTERNS
    .filter((s) => lines.some((l) => l.length <= 45 && s.re.test(l)))
    .map((s) => s.name);
}

/** Nombre de pages d'un PDF (objets /Type /Page), ou null si indéterminé. */
export function countPdfPages(pdf: Buffer): number | null {
  const n = (pdf.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
  return n > 0 ? n : null;
}

function level(score: number): AtsReport["level"] {
  return score >= 85 ? "excellent" : score >= 70 ? "bon" : score >= 45 ? "à améliorer" : "insuffisant";
}

export function analyzeCvForAts(rawText: string, meta: CvInputMeta): AtsReport {
  const raw = String(rawText || "").replace(/\r/g, "");
  const detached = (raw.match(DETACHED_ACCENT) || []).length;
  const text = detached ? repairDetachedAccents(raw) : raw;
  const wordCount = words(text);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const sections = findSections(text);
  const skills = extractSkillMentions(text);
  const checks: AtsCheck[] = [];

  // 1. Texte lisible (un CV scanné ou en image est vide pour un ATS)
  checks.push(wordCount >= 80
    ? { id: "text", label: "Texte lisible par un logiciel", status: "ok", detail: `${wordCount} mots lus sans difficulté.` }
    : wordCount >= 20
      ? { id: "text", label: "Texte lisible par un logiciel", status: "warn", detail: `Seulement ${wordCount} mots lus.`, advice: "Une partie du CV est sans doute une image (capture, texte vectorisé). Exportez-le depuis Word, Google Docs ou Canva en « PDF standard » avec du texte sélectionnable." }
      : { id: "text", label: "Texte lisible par un logiciel", status: "fail", detail: "Presque aucun texte n'a pu être lu.", advice: "Votre CV est probablement scanné ou enregistré en image : un logiciel de recrutement le verra vide. Recréez-le dans un traitement de texte et exportez-le en PDF avec du texte sélectionnable." });

  // 2. Caractères illisibles (icônes, polices sans correspondance Unicode, ligatures)
  const odd = (text.match(PRIVATE_USE) || []).length + (text.match(CID_GLYPHS) || []).length;
  const ligatures = (text.match(LIGATURES) || []).length;
  const oddRatio = text.length ? odd / text.length : 0;
  checks.push(detached >= 3
    ? { id: "characters", label: "Caractères reconnus", status: detached > 10 ? "fail" : "warn", detail: `${detached} lettres accentuées lues en deux signes (ex. « D´eveloppeur », « Exp´eriences »).`, advice: "Un logiciel de recrutement lira des mots déformés et ne trouvera ni vos compétences ni vos titres de section. Si votre CV est fait en LaTeX, ajoutez \\usepackage[T1]{fontenc} ; sinon, réexportez le PDF avec une police courante." }
    : oddRatio > 0.01
    ? { id: "characters", label: "Caractères reconnus", status: "fail", detail: `${odd} caractères illisibles (symboles, icônes ou police non standard).`, advice: "Remplacez les icônes et polices décoratives par une police courante (Arial, Calibri, Garamond…) : le texte doit se copier-coller correctement." }
    : odd > 0 || ligatures > 0
      ? { id: "characters", label: "Caractères reconnus", status: "warn", detail: [odd ? `${odd} symbole(s) ou icône(s) illisible(s)` : "", ligatures ? `${ligatures} ligature(s) typographique(s) (« fi », « fl » encodés en un seul signe)` : ""].filter(Boolean).join(" ; ") + ".", advice: "Un ATS peut ne pas reconnaître un mot contenant une ligature ou une icône (« planiﬁcation »). Désactivez les ligatures ou changez de police, et écrivez « Téléphone : » plutôt qu'une icône seule." }
      : { id: "characters", label: "Caractères reconnus", status: "ok", detail: "Aucun caractère illisible." });

  // 3. Coordonnées
  const hasEmail = EMAIL.test(text);
  const hasPhone = PHONE.test(text);
  checks.push(hasEmail && hasPhone
    ? { id: "contact", label: "Coordonnées", status: "ok", detail: "E-mail et téléphone trouvés." }
    : hasEmail || hasPhone
      ? { id: "contact", label: "Coordonnées", status: "warn", detail: hasEmail ? "Téléphone introuvable." : "E-mail introuvable.", advice: "Écrivez votre e-mail et votre téléphone en texte, en haut du CV (pas dans l'en-tête de page ni dans une image)." }
      : { id: "contact", label: "Coordonnées", status: "fail", detail: "Ni e-mail ni téléphone trouvés.", advice: "Ajoutez votre e-mail et votre téléphone en texte, en haut du CV : sans eux, le recruteur ne peut pas vous contacter." });

  // 4. Sections standard
  const required = SECTION_PATTERNS.filter((s) => s.required).map((s) => s.name);
  const missing = required.filter((n) => !sections.includes(n));
  checks.push(missing.length === 0
    ? { id: "sections", label: "Sections standard", status: "ok", detail: `Sections trouvées : ${sections.join(", ")}.` }
    : missing.length === 1
      ? { id: "sections", label: "Sections standard", status: "warn", detail: `Section introuvable : ${missing[0]}.`, advice: `Ajoutez un titre de section clair « ${missing[0]} » : les ATS classent le contenu grâce aux titres usuels.` }
      : { id: "sections", label: "Sections standard", status: "fail", detail: `Sections introuvables : ${missing.join(", ")}.`, advice: "Utilisez des titres usuels (« Expériences professionnelles », « Formations », « Compétences ») plutôt que des intitulés originaux." });

  // 5. Dates
  const years = (text.match(/\b(19[6-9]\d|20[0-4]\d)\b/g) || []).length;
  checks.push(years >= 2
    ? { id: "dates", label: "Dates des expériences", status: "ok", detail: `${years} dates repérées.` }
    : { id: "dates", label: "Dates des expériences", status: "warn", detail: "Peu ou pas de dates repérées.", advice: "Indiquez le mois et l'année de début et de fin de chaque expérience et formation (ex. « 03/2022 – 06/2024 »)." });

  // 6. Longueur
  const pages = meta.pages ?? null;
  const lengthIssues: string[] = [];
  if (wordCount > 0 && wordCount < 150) lengthIssues.push("CV très court");
  if (wordCount > 1100) lengthIssues.push("CV très long");
  if (pages && pages > 2) lengthIssues.push(`${pages} pages`);
  checks.push(lengthIssues.length === 0
    ? { id: "length", label: "Longueur", status: wordCount ? "ok" : "fail", detail: wordCount ? `${wordCount} mots${pages ? `, ${pages} page${pages > 1 ? "s" : ""}` : ""}.` : "Aucun contenu." }
    : { id: "length", label: "Longueur", status: "warn", detail: `${lengthIssues.join(", ")} (${wordCount} mots).`, advice: wordCount < 150 ? "Détaillez vos missions et réalisations réelles : un ATS a besoin de mots-clés pour vous classer." : "Visez une à deux pages : gardez les expériences les plus récentes et les plus liées au poste visé." });

  // 7. Listes à puces
  const bullets = lines.filter((l) => BULLET_LINE.test(l)).length;
  checks.push(bullets >= 3
    ? { id: "bullets", label: "Missions en liste", status: "ok", detail: `${bullets} lignes à puces.` }
    : { id: "bullets", label: "Missions en liste", status: "warn", detail: "Peu de listes à puces repérées.", advice: "Présentez vos missions en courtes lignes à puces simples (•, –) : c'est plus lisible pour le logiciel comme pour le recruteur." });

  // 8. Compétences identifiables
  checks.push(skills.length >= 5
    ? { id: "skills", label: "Compétences identifiables", status: "ok", detail: `${skills.length} compétences reconnues : ${skills.slice(0, 8).join(", ")}${skills.length > 8 ? "…" : ""}.` }
    : { id: "skills", label: "Compétences identifiables", status: "warn", detail: skills.length ? `Seulement ${skills.length} compétence(s) reconnue(s) : ${skills.join(", ")}.` : "Aucune compétence reconnue.", advice: "Listez vos outils, logiciels, techniques et savoir-faire réels avec leur nom exact (ex. « Excel », « Soins d'hygiène », « Permis B »)." });

  // 9. Mise en page (colonnes, tableaux) : beaucoup de lignes très courtes = texte découpé
  const shortLines = lines.filter((l) => l.length < 22).length;
  const shortRatio = lines.length ? shortLines / lines.length : 0;
  checks.push(lines.length < 8 || shortRatio < 0.45
    ? { id: "layout", label: "Mise en page lisible", status: "ok", detail: "Le texte se lit dans l'ordre, sans découpage excessif." }
    : { id: "layout", label: "Mise en page lisible", status: "warn", detail: `${Math.round(shortRatio * 100)} % des lignes sont très courtes : colonnes, tableaux ou zones de texte probables.`, advice: "Préférez une seule colonne : les colonnes et tableaux mélangent souvent l'ordre de lecture (vérifiez l'aperçu ci-dessous)." });

  let score = Math.round(checks.reduce((sum, c) => sum + (WEIGHTS[c.id] || 0) * (c.status === "ok" ? 1 : c.status === "warn" ? 0.5 : 0), 0));
  // Sans texte lisible, le reste n'a pas de sens ; caractères illisibles : mots déformés pour le logiciel
  if (checks[0].status === "fail") score = Math.min(score, 15);
  if (checks.find((c) => c.id === "characters")?.status === "fail") score = Math.min(score, 60);

  return {
    score,
    level: level(score),
    checks,
    stats: { words: wordCount, pages, sections, skills },
    preview: raw.trim().slice(0, 4000)
  };
}

// ---------------------------------------------------------------------------
// Correspondance CV / offre
// ---------------------------------------------------------------------------

// Sigles courants d'une offre qui ne sont pas des compétences
const ACRONYM_STOPLIST = new Set([
  "CDI", "CDD", "CV", "H", "F", "HF", "SA", "SAS", "SARL", "SASU", "EURL", "TTC", "HT", "UE", "FR", "EN", "NB", "PS", "RTT",
  "CE", "CSE", "PME", "TPE", "ETI", "PDG", "DG", "IDF", "BAC", "K", "KE", "EUR", "USD", "ET", "OU", "LE", "LA", "LES", "DE", "DES", "DU",
  "AU", "AUX", "EN", "UN", "UNE", "VOUS", "NOUS", "NOTRE", "VOTRE", "OFFRE", "POSTE", "MISSIONS", "PROFIL", "ENTREPRISE", "AVANTAGES", "SALAIRE"
]);

export interface MatchReport {
  /** 0–100, ou null si l'offre ne contient aucun mot-clé reconnu. */
  score: number | null;
  matched: string[];
  missing: string[];
  keywords: string[];
}

const STOPWORDS = new Set(("a à au aux avec ce ces cet cette d de des du dans en et est être il ils je l la le les leur leurs mais ne nos notre nous on ou où par pas pour qu que qui sa se ses son sont sur ta te tes ton tu un une vos votre vous y " +
  "afin ainsi alors aussi auprès avoir bien chez comme dont elle elles entre etc faire fait lors même plus peu selon sous tout tous toute toutes très via").split(" ").map(normalizeSkill));
// Mots qui ne décrivent pas une compétence : intitulés de rubrique, contrat, niveau d'exigence
const GENERIC = new Set(("poste postes profil profils mission missions offre entreprise société candidat candidate h f hf cdi cdd stage alternance intérim interim temps plein partiel " +
  "salaire rémunération remuneration avantages lieu date début debut durée duree contrat description recherche recherchons rejoindre rejoignez " +
  "obligatoire obligatoires souhaité souhaitée souhaités souhaitées apprécié appréciée appréciés appréciées exigé exigée exigés exigées indispensable indispensables requis requise requises impératif idéalement minimum plus " +
  "maîtrise maitrise connaissance connaissances expérience experience expériences experiences pratique capacité capacites capacités aptitude aptitudes sens goût gout bonne bonnes bon bons excellente excellent " +
  "vous nous notre votre qualité qualités qualites savoir être niveau année années an ans mois jour jours " +
  // Noms d'action qui accompagnent la compétence sans la définir (« développement de… », « gestion de… »)
  "développement developpement gestion suivi participation réalisation realisation mise place").split(" ").map(normalizeSkill));

const tokens = (s: string) => normalizeSkill(s).split(/[^a-z0-9+#]+/).filter(Boolean);
const significant = (s: string) => tokens(s).filter((w) => !STOPWORDS.has(w) && !GENERIC.has(w) && (w.length >= 3 || /\d/.test(w)));

/** Expressions courtes de l'offre (« soins d'hygiène et de confort », « permis B », « logiciel NetSoins »). */
export function offerPhrases(offerText: string): string[] {
  const out: string[] = [];
  // « H/F », « (e) » : mentions légales et écriture inclusive, pas des compétences
  const cleaned = String(offerText || "").replace(/\(?\b[HF]\s*\/\s*[FH]\b\)?/g, " ").replace(/\((e|es|ne|ère)\)/gi, "");
  const segments = cleaned.split(/[\n•;,.:()!?]|\s[-–—]\s|\/(?=\s)/);
  for (let seg of segments) {
    seg = seg.replace(/\s+/g, " ").trim();
    // Phrase rédigée (« Vous assurerez l'accueil… ») : trop longue pour être un mot-clé
    if (!seg || seg.split(" ").length > 7 || /\b(vous|nous|notre|votre|je|il|elle)\b/i.test(seg)) continue;
    // Retire l'exigence autour de la compétence : « maîtrise du », « obligatoire », « souhaitée »…
    const words = seg.split(" ");
    // Tête d'expression : on retire les mots vides et génériques ; « d'interfaces » → « interfaces »
    while (words.length) {
      const elided = words[0].match(/^(?:d|l|qu)['’](.+)$/i);
      if (elided) words[0] = elided[1];
      const w = normalizeSkill(words[0]);
      if (GENERIC.has(w) || STOPWORDS.has(w) || /^(d|l|qu)['’]?$/i.test(words[0])) words.shift();
      else break;
    }
    while (words.length && (GENERIC.has(normalizeSkill(words[words.length - 1])) || STOPWORDS.has(normalizeSkill(words[words.length - 1])))) words.pop();
    const phrase = words.join(" ").replace(/^(d|l)['’]/i, "").trim();
    const sig = significant(phrase);
    // « Permis B » : lettre de catégorie conservée
    const permis = /^permis [a-z]{1,2}$/i.test(phrase);
    if (!permis && (sig.length === 0 || sig.length > 5)) continue;
    if (phrase.length < 3) continue;
    out.push(phrase);
  }
  return out;
}

/** Mots-clés d'une offre : compétences reconnues, sigles métier (CACES, HACCP, SAP…) et expressions de l'offre. */
export function offerKeywords(offerText: string): string[] {
  const text = String(offerText || "");
  const skills = extractSkillMentions(text);
  const acronyms = (text.match(/\b[A-Z][A-Z0-9]{1,7}\b/g) || []).filter((a) => !ACRONYM_STOPLIST.has(a) && !/^\d+$/.test(a));
  const seen = new Set<string>();
  const out: string[] = [];
  // Compétences reconnues, puis expressions, puis sigles isolés (« API » inutile si « API REST » est déjà retenu)
  for (const k of [...skills, ...offerPhrases(text), ...acronyms]) {
    const key = normalizeSkill(k);
    if (!key || seen.has(key)) continue;
    // Déjà couvert par un mot-clé plus précis (« SQL » dans « PostgreSQL », « DEAS » dans « DEAS obligatoire »)
    const sig = significant(k).join(" ");
    if (out.some((o) => { const os = significant(o).join(" "); return os === sig || tokens(o).includes(key) || (sig && os.includes(sig)); })) continue;
    seen.add(key);
    out.push(k);
  }
  return out.slice(0, 30);
}

/** Mot présent dans le CV, au pluriel ou au féminin près (« transmission » / « transmissions »). */
function wordInCv(w: string, cvTokens: Set<string>, cvList: string[]): boolean {
  if (cvTokens.has(w)) return true;
  if (w.length < 5) return false;
  const stem = w.slice(0, Math.max(4, w.length - 2));
  return cvList.some((t) => t.startsWith(stem));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function matchCvToOffer(cvText: string, offerText: string): MatchReport {
  const keywords = offerKeywords(offerText);
  if (!keywords.length) return { score: null, matched: [], missing: [], keywords };
  const cv = String(cvText || "");
  const cvNorm = normalizeSkill(cv);
  const cvSkills = extractSkillMentions(cv);
  const cvList = tokens(cv);
  const cvTokens = new Set(cvList);
  const matched: string[] = [];
  const missing: string[] = [];
  for (const k of keywords) {
    const norm = normalizeSkill(k);
    const inText = norm.length > 1 && new RegExp(`(^|[^a-z0-9])${escapeRe(norm)}([^a-z0-9]|$)`).test(cvNorm);
    // Expression : tous ses mots importants (1–2 mots) ou au moins deux tiers (3 mots et plus) dans le CV
    const sig = significant(k);
    const found = sig.filter((w) => wordInCv(w, cvTokens, cvList)).length;
    // 1 mot : présent ; 2 mots : le nom principal (le premier en français) ; 3 et plus : deux tiers
    const phraseOk = sig.length > 0 && !/^permis /i.test(k) && (
      sig.length === 1 ? found === 1 : sig.length === 2 ? wordInCv(sig[0], cvTokens, cvList) : found / sig.length >= 2 / 3);
    (inText || phraseOk || candidateHasSkill(cvSkills, k) ? matched : missing).push(k);
  }
  return { score: Math.round((matched.length / keywords.length) * 100), matched, missing, keywords };
}
