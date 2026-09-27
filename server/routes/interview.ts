import type { Express } from "express";
import { getGeminiClient, callGeminiResilient, extractJsonObject, candidateBrief, MODEL_FAST } from "../ai.ts";
import { generateFallbackPrepKit } from "../fallbacks.ts";
import { requireQuota } from "../plans.ts";
import { evaluateStarLocally } from "../starCheck.ts";

export function registerInterviewRoutes(app: Express) {
  // 5. Kit de préparation d'entretien
  app.post("/api/interview/prep-kit", requireQuota("interview"), async (req, res) => {
    const { candidate, job } = req.body || {};
    const fallback = () => (res.locals.noCharge = true, res).json({ source: "standard-coaching-model", ...generateFallbackPrepKit(candidate, job) });

    const ai = getGeminiClient();
    if (!ai) return fallback();

    try {
      const prompt = `Tu es un coach en préparation d'entretiens d'embauche.
Génère un kit de préparation sur mesure. Base-toi sur les VRAIES expériences du candidat pour les trames de réponse, sans rien inventer.
Si tu ne connais pas l'entreprise de façon fiable, dis-le dans la synthèse au lieu d'inventer.

CANDIDAT :
${candidateBrief(candidate)}

POSTE : ${job?.title || ""} chez ${job?.company || ""}
Description : ${job?.description || "(non disponible)"}
Compétences demandées : ${JSON.stringify(job?.skillsRequired || [])}
Compétences demandées absentes du profil (à préparer en priorité) : ${JSON.stringify(job?.missingKeywords || [])}

Renvoie uniquement un JSON valide :
{
  "companySynthesis": {
    "summary": "synthèse de 2 phrases sur l'entreprise",
    "coreChallenges": ["défi 1", "défi 2", "défi 3"],
    "techStackAnticipated": ["compétence/outil 1", "outil 2"],
    "culturalValues": ["valeur 1", "valeur 2"]
  },
  "elevatorPitch": "pitch de 90 secondes basé sur le parcours réel du candidat",
  "topQuestions": [
    {
      "question": "question précise",
      "category": "Technique" ou "Comportemental / Culture" ou "Projet" ou "Motivation",
      "whyTheyAsk": "pourquoi le recruteur la pose",
      "suggestedAnswer": "trame de réponse s'appuyant sur une expérience réelle du candidat",
      "keyPoints": ["point clé 1", "point clé 2"]
    }
  ],
  "smartQuestionsToAskInterviewer": ["question 1", "question 2", "question 3"]
}
Fournis 6 à 8 questions, dont au moins une sur chaque compétence manquante.`;

      const response = await callGeminiResilient(ai, { preferredModel: MODEL_FAST, contents: prompt });
      const parsed = extractJsonObject(response.text || "");
      if (parsed && Array.isArray(parsed.topQuestions) && parsed.topQuestions.length > 0 && parsed.companySynthesis) {
        return res.json({ source: "gemini-ai", ...parsed });
      }
      return fallback();
    } catch {
      return fallback();
    }
  });

  // 6. Évaluation d'une réponse d'entretien
  app.post("/api/interview/evaluate-answer", requireQuota("rewrite"), async (req, res) => {
    const { question, answer, jobTitle, company, candidate } = req.body || {};
    const unavailable = (verdict: string) => (res.locals.noCharge = true, res).json({
      source: "unavailable",
      score: null,
      verdict,
      starBreakdown: { situation: "", task: "", action: "", result: "" },
      strengths: [],
      improvements: [],
      improvedSample: ""
    });

    if (!answer || !String(answer).trim()) return unavailable("Rédigez votre réponse pour obtenir une évaluation.");
    const ai = getGeminiClient();
    // Sans IA (ou si elle échoue) : évaluation STAR automatique, sans réécriture et non décomptée du forfait
    const local = () => (res.locals.noCharge = true, res).json(evaluateStarLocally(String(answer)));
    if (!ai) return local();

    try {
      const prompt = `Tu es un recruteur expert et coach d'entretien.
Évalue la réponse du candidat pour le poste de "${jobTitle || "Poste"}" chez "${company || "l'entreprise"}".
${candidate ? `\nProfil réel du candidat (pour vérifier la cohérence, ne rien inventer dans la reformulation) :\n${candidateBrief(candidate)}\n` : ""}
Question posée : "${question}"
Réponse du candidat : "${answer}"

Analyse avec la méthode STAR. Renvoie uniquement un JSON valide :
{
  "score": entier de 1 à 10,
  "verdict": "une phrase de synthèse",
  "starBreakdown": { "situation": "...", "task": "...", "action": "...", "result": "..." },
  "strengths": ["..."],
  "improvements": ["..."],
  "improvedSample": "reformulation améliorée, fidèle aux faits donnés par le candidat"
}`;
      const response = await callGeminiResilient(ai, { preferredModel: MODEL_FAST, contents: prompt });
      const parsed = extractJsonObject(response.text || "");
      if (parsed && typeof parsed.score === "number") {
        return res.json({ source: "gemini-ai", ...parsed });
      }
      return local();
    } catch {
      return local();
    }
  });
}
