/**
 * Recherche Google via Gemini (outil googleSearch) pour la découverte d'offres :
 * texte de la réponse + pages réellement consultées (métadonnées de grounding).
 */
import { callGeminiResilient, getGeminiClient, MODEL_FAST } from "../ai.ts";
import type { GroundedSearchFn } from "./webDiscovery.ts";

export const groundedWebSearch: GroundedSearchFn = async (prompt) => {
  const ai = getGeminiClient();
  if (!ai) throw new Error("Gemini indisponible");
  const r: any = await callGeminiResilient(ai, { preferredModel: MODEL_FAST, contents: prompt, config: { tools: [{ googleSearch: {} }], temperature: 0 } });
  const chunks: any[] = r?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return {
    text: r?.text || "",
    sources: chunks.map((c) => ({ uri: String(c?.web?.uri || ""), title: c?.web?.title ? String(c.web.title) : undefined })).filter((c) => /^https:\/\//.test(c.uri))
  };
};

/** Liens de résultats Google (redirections) → adresse réelle de la page. */
export async function resolveGroundingUrl(uri: string): Promise<string> {
  if (!/^https:\/\/vertexaisearch\.cloud\.google\.com\//.test(uri)) return uri;
  const res = await fetch(uri, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(8000) });
  const location = res.headers.get("location");
  return location && /^https?:\/\//.test(location) ? location : uri;
}

/** Recherche web activée : clé Gemini présente et DISCOVERY_WEB différent de "off". */
export const webDiscoveryEnabled = () => !!process.env.GEMINI_API_KEY && process.env.DISCOVERY_WEB !== "off";
