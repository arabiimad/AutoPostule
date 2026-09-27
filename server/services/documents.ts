/**
 * Préparation des documents d'une candidature (CV adapté, lettre), partagée par les routes de l'interface
 * et par le worker d'auto-candidature : mêmes prompts, mêmes garde-fous, même rendu.
 *
 * `autonomousReadiness` décide si un dossier peut partir SANS relecture humaine : toute vérification
 * indisponible ou négative bloque l'envoi autonome (le dossier reste prêt pour une validation manuelle).
 */
import { isFarFromProfile } from "../../src/utils/skillMatcher.ts";
import { tailorCv, buildGuard, inventedContent, type OfferAnalysis, type TailoredCv, type GenerateFn } from "../cvPipeline.ts";
import { tailorFailureNotice } from "../aiErrors.ts";
import { getGeminiClient, callGeminiResilient, makeGenerate, cachedOfferAnalysis, candidateBrief, isRateLimitOrQuotaError, MODEL_BEST, MODEL_FAST } from "../ai.ts";
import { generateFallbackLetter } from "../fallbacks.ts";

export interface PreparedCv {
  tailored: TailoredCv;
  analysis: OfferAnalysis;
  rejected: { where: string; reason: string }[];
  source: "ai" | "profile";
  reviewed: boolean;
  far: boolean;
  notices: string[];
  models: string[];
  error?: string;
}

export interface PreparedLetter {
  letter: string;
  source: "ai" | "template";
  notice?: string;
}

/** Analyse de l'offre puis contenu adapté du CV, avec garde-fous et relecture. */
export async function prepareCv(candidate: any, job: any, opts: { premium?: boolean; generate?: GenerateFn | null } = {}): Promise<PreparedCv> {
  const ai = opts.generate === undefined ? getGeminiClient() : null;
  const gen = ai ? makeGenerate(ai, { allowBest: !!opts.premium }) : null;
  const generate = opts.generate !== undefined ? opts.generate : gen?.generate || null;
  const analysis = await cachedOfferAnalysis(generate, job);
  const result = await tailorCv(generate, candidate, job, analysis);
  // Offre hors du parcours : le titre du CV reste le vrai titre du candidat (pas de titre « passerelle » inventé)
  const far = isFarFromProfile(candidate, job);
  if (far && candidate?.title) result.tailored.headline = String(candidate.title);

  const notices: string[] = [];
  if (!generate) notices.push("Service IA indisponible : CV construit à partir de votre profil, sans reformulation.");
  else if (result.source !== "ai") notices.push(tailorFailureNotice(result.error));
  if (far) {
    notices.push("Ce poste semble éloigné de votre parcours : votre titre est conservé et seules vos compétences transférables sont mises en avant. Vérifiez que l'offre vous correspond avant de postuler.");
  }
  if (result.rejected.length) {
    const n = result.rejected.length;
    notices.push(`${n === 1 ? "Une reformulation de l'IA a été écartée" : `${n} reformulations de l'IA ont été écartées`} car ${n === 1 ? "elle ajoutait" : "elles ajoutaient"} des éléments absents de votre profil : vos phrases d'origine sont conservées.`);
  }
  return { ...result, analysis, far, notices, models: gen?.used || [] };
}

export function buildLetterPrompt(candidate: any, job: any, analysis: any): string {
  return `Rédige une lettre de motivation en français, sur mesure, pour :

PROFIL DU CANDIDAT :
${candidateBrief(candidate)}

${job?.isSpontaneous
  ? `CANDIDATURE SPONTANÉE (aucune offre publiée) :
Entreprise : ${job?.company || ""}
Secteur : ${job?.companySector || "non précisé"}
Effectif : ${job?.companySize || "non précisé"}
Contrat recherché : alternance
Métier visé : ${String(job?.title || "").replace(/^Candidature spontanée — /, "")}
Écris une lettre de candidature spontanée : explique pourquoi cette entreprise et ce secteur, ce que le candidat peut apporter, et propose un échange. N'invente aucune information sur l'entreprise.`
  : `OFFRE CIBLÉE :
Intitulé : ${job?.title || ""}
Entreprise : ${job?.company || ""}
Description : ${job?.description || ""}
Mots-clés recherchés : ${(job?.skillsRequired || []).join(", ")}`}

ANALYSE DE L'OFFRE : ${JSON.stringify(analysis)}

DIRECTIVES :
- Registre : ${analysis?.tone || "professionnel"} ; reprends le vocabulaire de l'offre quand il décrit fidèlement le parcours du candidat.
- Structure : accroche liée à l'entreprise ou au poste, 2 paragraphes reliant des expériences réelles aux missions/exigences, conclusion avec proposition d'échange.
- N'invente rien d'absent du profil (expériences, chiffres, diplômes, niveaux).
- Relie concrètement les vraies expériences du candidat aux besoins de ${job?.company || "l'entreprise"}.
- Ton direct, professionnel, sans formules creuses. 250 à 350 mots.
- Renvoie UNIQUEMENT le texte de la lettre (de « Madame, Monsieur, » à la signature), sans titre, sans commentaire, sans markdown.`;
}

/** Lettre sur mesure (IA), ou lettre modèle à personnaliser si l'IA est indisponible. */
export async function writeLetter(candidate: any, job: any, opts: { premium?: boolean; analysis?: any } = {}): Promise<PreparedLetter> {
  const template = (notice: string): PreparedLetter => ({ source: "template", notice, letter: generateFallbackLetter(candidate, job) });
  const ai = getGeminiClient();
  if (!ai) return template("Service IA indisponible : lettre modèle à personnaliser.");
  try {
    const { generate } = makeGenerate(ai, { allowBest: !!opts.premium });
    // Même analyse que le CV (en cache) : lettre et CV mettent en avant les mêmes points
    const analysis = opts.analysis && typeof opts.analysis === "object" ? opts.analysis : await cachedOfferAnalysis(generate, job);
    const response = await callGeminiResilient(ai, { preferredModel: opts.premium ? MODEL_BEST : MODEL_FAST, contents: buildLetterPrompt(candidate, job, analysis) });
    const letter = (response.text || "").replace(/^```[a-z]*\n?|```$/g, "").trim();
    if (letter.length > 100) return { source: "ai", letter };
    return template("Réponse IA vide : lettre modèle à personnaliser.");
  } catch (e: any) {
    return template(isRateLimitOrQuotaError(e)
      ? "L'assistant IA est très sollicité en ce moment : voici une lettre modèle à personnaliser. Réessayez dans quelques minutes pour une lettre sur mesure."
      : "L'assistant IA n'a pas répondu : voici une lettre modèle à personnaliser.");
  }
}

/**
 * Contrôle des faits de la lettre : chiffres, outils et compétences exigées doivent venir du profil
 * (ou, pour les chiffres, de l'intitulé et du nom de l'entreprise). Renvoie les problèmes trouvés.
 */
export function checkLetterFacts(letter: string, candidate: any, job: any, analysis?: OfferAnalysis): string[] {
  const guard = buildGuard({ ...candidate, _offer: { title: job?.title, company: job?.company } }, job, analysis);
  const problems: string[] = [];
  for (const paragraph of String(letter || "").split(/\n\s*\n/)) {
    // Dates et années de la lettre (« le 12/03/2026 ») : la date du jour est ajoutée par le modèle
    const text = paragraph.replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "");
    const reason = inventedContent(text, guard);
    if (reason) problems.push(reason);
  }
  return Array.from(new Set(problems));
}

/**
 * Le dossier peut-il partir sans relecture humaine ?
 * - CV : contenu du profil tel quel, ou reformulation IA dont la relecture sémantique a abouti ;
 * - lettre : rédigée sur mesure (pas un modèle générique) et sans élément absent du profil ;
 * - offre éloignée du parcours : validation humaine.
 */
export function autonomousReadiness(cv: PreparedCv, letter: PreparedLetter, candidate: any, job: any): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (cv.source === "ai" && !cv.reviewed) reasons.push("La relecture du CV par l'IA n'a pas pu être faite.");
  if (cv.far) reasons.push("Le poste semble éloigné de votre parcours.");
  if (letter.source !== "ai") reasons.push("La lettre est un modèle générique à personnaliser.");
  else {
    const problems = checkLetterFacts(letter.letter, candidate, job, cv.analysis);
    if (problems.length) reasons.push(`La lettre contient des éléments absents de votre profil (${problems.slice(0, 2).join(" ; ")}).`);
  }
  return { ok: reasons.length === 0, reasons };
}
