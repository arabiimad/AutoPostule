import { GoogleGenAI } from "@google/genai";
import { createHash } from "node:crypto";
import { kv, countApiCall } from "./store.ts";
import { logEvent } from "./log.ts";
import { analyzeOffer, type GenerateFn, type OfferAnalysis } from "./cvPipeline.ts";

// Modèles Gemini : le plus puissant pour rédiger (CV, lettre, retouches), le rapide pour analyser.
// Les modèles Pro exigent un projet Google Cloud avec facturation activée : sinon repli automatique sur Flash.
export const MODEL_BEST = process.env.GEMINI_MODEL_BEST || "gemini-3.1-pro-preview";
export const MODEL_FAST = process.env.GEMINI_MODEL_FAST || "gemini-3.8-flash";
export const MODEL_FALLBACKS = ["gemini-3.6-flash", "gemini-3.5-flash"];
/** Modèles indisponibles pour cette clé (facturation, accès) : évités pendant une heure. */
export const unavailableModels = new Map<string, number>();

export function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      // Surcharge possible (tests de bout en bout, proxy d'entreprise)
      ...(process.env.GEMINI_API_BASE_URL ? { baseUrl: process.env.GEMINI_API_BASE_URL } : {}),
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
}

export { isRateLimitOrQuotaError } from "./aiErrors.ts";
import { isRateLimitOrQuotaError } from "./aiErrors.ts";

export async function callGeminiResilient(
  ai: GoogleGenAI,
  params: {
    contents: any;
    config?: any;
    preferredModel?: string;
  }
) {
  const now = Date.now();
  const all = Array.from(new Set([params.preferredModel || MODEL_FAST, MODEL_FAST, ...MODEL_FALLBACKS]));
  const available = all.filter((m) => !((unavailableModels.get(m) || 0) > now));
  const models = available.length ? available : all;
  let lastError: any = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      void countApiCall("gemini");
      const response = await ai.models.generateContent({
        model,
        contents: params.contents,
        ...(params.config ? { config: params.config } : {})
      });
      if (response && response.text) {
        (response as any).__model = model;
        return response;
      }
    } catch (err: any) {
      lastError = err;
      const errMsg = String(err?.message || '');
      const isLast = i === models.length - 1;

      // Modèle non accessible avec cette clé (Pro sans facturation, accès restreint) : on passe au suivant
      if (!isLast && (err?.status === 403 || err?.code === 403 || /billing|FAILED_PRECONDITION|PERMISSION_DENIED|free tier|not available|restricted/i.test(errMsg))) {
        unavailableModels.set(model, Date.now() + 3600_000);
        logEvent("warn", "gemini_model_unavailable", { model, message: errMsg.slice(0, 200) });
        continue;
      }
      // Quota épuisé sur le modèle Pro : le modèle rapide a son propre quota
      if (!isLast && model === MODEL_BEST && (err?.status === 429 || err?.code === 429)) {
        continue;
      }

      // Requête invalide ou modèle inexistant (400/404) : passer au modèle suivant sans attendre
      if (err?.status === 404 || err?.code === 404 || errMsg.includes('NOT_FOUND')) {
        continue;
      }
      if (err?.status === 400 || err?.code === 400 || errMsg.includes('INVALID_ARGUMENT')) {
        break;
      }
      // Quota du compte épuisé : inutile d'essayer d'autres modèles
      if (err?.status === 429 || err?.code === 429 || errMsg.includes('exceeded your current quota')) {
        break;
      }

      // Surcharge temporaire avec outil de recherche : réessayer sans l'outil
      if (params.config?.tools && isRateLimitOrQuotaError(err)) {
        try {
          const responseWithoutTools = await ai.models.generateContent({ model, contents: params.contents });
          if (responseWithoutTools && responseWithoutTools.text) {
            return responseWithoutTools;
          }
        } catch (retryErr) {
          lastError = retryErr;
        }
      }

      await new Promise((r) => setTimeout(r, Math.min(300 * (i + 1), 900)));
    }
  }

  throw lastError || new Error("NO_AI_RESPONSE");
}

/** Extrait le premier objet JSON d'une réponse de modèle. */
export function extractJsonObject(text: string): any | null {
  const match = (text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/** Fonction d'appel à l'IA pour la chaîne de génération du CV ; `used` liste les modèles ayant répondu. */
export function makeGenerate(ai: GoogleGenAI, options: { allowBest?: boolean } = {}): { generate: GenerateFn; used: string[] } {
  const used: string[] = [];
  const allowBest = options.allowBest !== false;
  const generate: GenerateFn = async (prompt, { quality, json }) => {
    const r: any = await callGeminiResilient(ai, {
      // Forfait gratuit : modèle rapide uniquement ; Premium : modèle le plus puissant pour la rédaction
      preferredModel: quality === "best" && allowBest ? MODEL_BEST : MODEL_FAST,
      contents: prompt,
      config: json ? { responseMimeType: "application/json", temperature: quality === "best" ? 0.4 : 0.1 } : undefined
    });
    if (r?.__model) used.push(r.__model);
    return r?.text || "";
  };
  return { generate, used };
}

/** Analyse d'offre mise en cache 7 jours (même offre = même analyse, un seul appel IA). */
export async function cachedOfferAnalysis(generate: GenerateFn | null, job: any): Promise<OfferAnalysis> {
  const key = `offer:${createHash("sha1").update(`${job?.title}|${job?.company}|${String(job?.description || "").slice(0, 4000)}`).digest("hex")}`;
  const hit = await kv().get(key);
  if (hit) {
    try { return JSON.parse(hit); } catch { /* recalcul */ }
  }
  const analysis = await analyzeOffer(generate, job);
  if (analysis.source === "ai") await kv().set(key, JSON.stringify(analysis), 7 * 86400);
  return analysis;
}

export function candidateBrief(candidate: any): string {
  const exps = (candidate?.experiences || []).map((e: any) => ({ poste: e.title, entreprise: e.company, periode: [e.startDate, e.endDate].filter(Boolean).join(" - "), realisations: e.bullets }));
  const edu = (candidate?.education || []).map((ed: any) => ({ diplome: ed.degree, etablissement: ed.institution, annee: ed.year }));
  return `Nom : ${candidate?.fullName || "(non renseigné)"}
Titre : ${candidate?.title || "(non renseigné)"}
Compétences : ${JSON.stringify(candidate?.skills || [])}
Expériences : ${JSON.stringify(exps)}
Formations : ${JSON.stringify(edu)}
Langues : ${JSON.stringify(candidate?.languages || [])}`;
}

/**
 * Message lisible par l'utilisateur à partir d'une erreur du fournisseur d'IA
 * (jamais de JSON brut, de nom de modèle ni de lien technique à l'écran).
 */
export function friendlyAiError(error: unknown): string {
  const raw = String((error as any)?.message || (error as any)?.status || error || "");
  if (/429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(raw)) return "le service d'IA a atteint sa limite d'utilisation pour le moment";
  if (/503|UNAVAILABLE|overloaded|high demand/i.test(raw)) return "le service d'IA est momentanément surchargé";
  if (/timeout|TIMEOUT|ETIMEDOUT|aborted/i.test(raw)) return "le service d'IA a mis trop de temps à répondre";
  if (/401|403|API key|PERMISSION_DENIED|billing/i.test(raw)) return "le service d'IA n'est pas accessible avec la configuration actuelle";
  return "le service d'IA n'a pas pu traiter la demande";
}
