/**
 * Base de réponses aux questions des formulaires de candidature.
 *
 * Ordre de résolution pour chaque question :
 *  1. réponse enregistrée par l'utilisateur (même question ou formulation très proche) ;
 *  2. donnée du profil (nom, email, téléphone, ville, liens, langues) ;
 *  3. IA (Gemini) à partir du profil, avec un niveau de confiance — jamais pour les catégories sensibles ;
 *  4. sinon : l'agent met la candidature en pause et pose la question à l'utilisateur.
 * La réponse de l'utilisateur est enregistrée et resservira sur tous les sites suivants.
 */
import type { PendingQuestion, QuestionCategory, SavedAnswer } from "./types.ts";

const STOPWORDS = new Set(
  "a au aux avec avez ce ces dans de des du en et est etes etesvous il indiquez indiquer je la le les leur mais me merci mon nous ou par pas pour pouvez precisez preciser qu que quel quelle quels quelles qui sa se ses son sont sur ta te tes ton tu un une vos votre vous y the a an and are do does for have how in is of on or please to what which with you your".split(" ")
);

/** Clé stable d'une question : minuscules, sans accents ni ponctuation ni mots vides. */
export function questionKey(label: string): string {
  const words = String(label || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !STOPWORDS.has(w));
  return words.join("_").slice(0, 120) || "question";
}

function tokens(key: string) {
  return new Set(key.split("_").filter(Boolean));
}

/** Similarité de Jaccard entre deux clés. */
export function keySimilarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const CATEGORY_PATTERNS: [QuestionCategory, RegExp][] = [
  ["diversity", /handicap|disabilit|rqth|genre|gender|sexe|ethni|origine|race|veteran|orientation|religio|pronom/],
  ["legal", /casier|criminal|condamn|non.?concurrence|non.?compete|consent|rgpd|gdpr|certifie|attest|conditions/],
  ["work_authorization", /autoris|authori[sz]|visa|titre sejour|permis travail|work permit|sponsor|nationalit|citizen/],
  ["salary", /salai|remuneration|pretention|salary|compensation|package|brut|annuel/],
  ["availability", /disponib|date debut|start date|preavis|notice|quand.*commencer|available/],
  ["relocation", /demenag|relocat|mobilit|teletravail|remote|deplacement|travel/],
  ["experience", /annees|years|experience|niveau|level|maitris|proficien/],
  ["motivation", /pourquoi|why|motivation|interesse|decri|describe|parlez|tell us|lettre/],
  ["identity", /nom|name|prenom|email|mail|telephone|phone|adresse|address|ville|city|code postal|zip|linkedin|github|portfolio|site web|website|url/]
];

export function categorize(label: string): QuestionCategory {
  const text = String(label || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  for (const [cat, re] of CATEGORY_PATTERNS) if (re.test(text)) return cat;
  return "other";
}

/**
 * Catégories où l'IA ne répond jamais : la réponse engage l'utilisateur (droit, argent, données sensibles).
 * Seule une réponse enregistrée par l'utilisateur est utilisée ; sinon on lui pose la question.
 */
export const USER_ONLY_CATEGORIES = new Set<QuestionCategory>(["work_authorization", "salary", "availability", "relocation", "diversity", "legal"]);

export interface FormQuestion {
  label: string;
  options?: string[];
  required?: boolean;
}

export type AnswerSource = "saved" | "profile" | "ai";

export interface ResolvedAnswer {
  key: string;
  label: string;
  category: QuestionCategory;
  answer: string;
  source: AnswerSource;
  confidence: number;
}

export type AiAnswerFn = (q: { label: string; category: QuestionCategory; options?: string[] }, profile: any, job: any) =>
  Promise<{ answer: string; confidence: number } | null>;

/** Confiance minimale pour qu'une réponse de l'IA soit utilisée sans demander. */
export const AI_CONFIDENCE_THRESHOLD = 0.8;
/** Similarité minimale pour réutiliser une réponse enregistrée à une question formulée autrement. */
export const SIMILARITY_THRESHOLD = 0.75;

function fromProfile(label: string, profile: any): string | null {
  const t = String(label || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const p = profile || {};
  const [first, ...rest] = String(p.fullName || "").trim().split(/\s+/);
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  if (/linkedin/.test(t)) return pick(p.linkedinUrl);
  if (/github/.test(t)) return pick(p.githubUrl);
  if (/portfolio|site web|website|site personnel/.test(t)) return pick(p.portfolioUrl);
  if (/e.?mail|courriel/.test(t)) return pick(p.email);
  if (/telephone|phone|portable|mobile/.test(t)) return pick(p.phone);
  if (/prenom|first name|given name/.test(t)) return pick(first);
  if (/(^|\s)nom de famille|last name|family name|surname/.test(t)) return pick(rest.join(" "));
  if (/nom complet|full name|^nom$|^name$|nom et prenom|prenom et nom/.test(t)) return pick(p.fullName);
  if (/ville|city|localisation|location/.test(t)) return pick(p.location);
  if (/langues?|languages?/.test(t) && Array.isArray(p.languages) && p.languages.length) return p.languages.join(", ");
  return null;
}

function matchOption(answer: string, options?: string[]): string | null {
  if (!options?.length) return answer;
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const a = norm(answer);
  return options.find((o) => norm(o) === a) || options.find((o) => norm(o).includes(a) || a.includes(norm(o))) || null;
}

export function findSaved(label: string, saved: SavedAnswer[]): SavedAnswer | null {
  const key = questionKey(label);
  const exact = saved.find((s) => s.key === key);
  if (exact) return exact;
  let best: SavedAnswer | null = null, score = 0;
  for (const s of saved) {
    const sim = keySimilarity(key, s.key);
    if (sim > score) [best, score] = [s, sim];
  }
  return score >= SIMILARITY_THRESHOLD ? best : null;
}

export async function resolveQuestions(
  questions: FormQuestion[],
  ctx: { saved: SavedAnswer[]; profile: any; job?: any; ai?: AiAnswerFn | null; overrides?: Record<string, string> }
): Promise<{ resolved: ResolvedAnswer[]; unresolved: PendingQuestion[] }> {
  const resolved: ResolvedAnswer[] = [];
  const unresolved: PendingQuestion[] = [];

  for (const q of questions) {
    const key = questionKey(q.label);
    const category = categorize(q.label);
    const base = { key, label: q.label, category };
    const accept = (answer: string | null | undefined, source: AnswerSource, confidence: number) => {
      const value = answer == null ? null : matchOption(String(answer), q.options);
      if (value == null || !value.trim()) return false;
      resolved.push({ ...base, answer: value, source, confidence });
      return true;
    };

    // Réponse donnée par l'utilisateur pendant cette candidature
    if (ctx.overrides?.[key] != null && accept(ctx.overrides[key], "saved", 1)) continue;

    const saved = findSaved(q.label, ctx.saved);
    if (saved && accept(saved.answer, "saved", 1)) continue;

    if (category === "identity" && accept(fromProfile(q.label, ctx.profile), "profile", 1)) continue;

    if (!USER_ONLY_CATEGORIES.has(category) && ctx.ai) {
      try {
        const out = await ctx.ai({ label: q.label, category, options: q.options }, ctx.profile, ctx.job);
        if (out && out.confidence >= AI_CONFIDENCE_THRESHOLD && accept(out.answer, "ai", out.confidence)) continue;
      } catch {
        /* IA indisponible : on demande à l'utilisateur */
      }
    }

    // Question facultative sans réponse fiable : laissée vide plutôt qu'inventée
    if (q.required === false) continue;
    unresolved.push({ ...base, ...(q.options?.length ? { options: q.options } : {}) });
  }
  return { resolved, unresolved };
}
