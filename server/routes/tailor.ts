import type { Express } from "express";
import { calculateCandidateMatch } from "../../src/utils/skillMatcher.ts";
import { generateFallbackLatex, generateLetterLatex, normalizeTemplate } from "../latex.ts";
import { aiErrorSummary } from "../aiErrors.ts";
import { applyTailored, sanitizeTailored, rewriteText, defaultTailored } from "../cvPipeline.ts";
import { getGeminiClient, callGeminiResilient, extractJsonObject, makeGenerate, candidateBrief, isRateLimitOrQuotaError, MODEL_BEST, MODEL_FAST } from "../ai.ts";
import { hasItems } from "../fallbacks.ts";
import { prepareCv, writeLetter } from "../services/documents.ts";
import { logEvent } from "../log.ts";
import { requireQuota } from "../plans.ts";

export function registerTailorRoutes(app: Express) {
  // 3. CV LaTeX adapté
  app.post("/api/tailor/latex", requireQuota("cv"), async (req: any, res) => {
    const { candidate, job } = req.body || {};
    const template = normalizeTemplate(req.body?.template ?? candidate?.preferredTemplate);

    if (!hasItems(candidate?.experiences)) {
      return res.status(400).json({
        error: "PROFIL_INCOMPLET",
        message: "Renseignez au moins une expérience dans votre profil avant de générer un CV."
      });
    }

    const match = calculateCandidateMatch(candidate?.skills || [], job?.skillsRequired || []);
    const premium = req.plan === "premium";

    // 1. Analyse de l'offre → 2. contenu adapté + garde-fous + relecture → 3. mise en forme par le modèle (jamais par l'IA)
    const result = await prepareCv(candidate, job, { premium });
    const { analysis, notices } = result;
    const gen = { used: result.models };
    const latexCode = generateFallbackLatex(applyTailored(candidate, result.tailored), job, template, { tailored: true });

    if (result.source !== "ai") res.locals.noCharge = true; // pas d'IA utilisée : non décompté
    // Détails techniques (modèle de repli, quota, erreur de Google) : journaux du serveur uniquement
    if (premium && gen?.used.length && !gen.used.includes(MODEL_BEST) && result.source === "ai") {
      // Problème de configuration (facturation) : pour l'exploitant, pas pour l'utilisateur
      logEvent("warn", "premium_model_unavailable", { model: MODEL_BEST, used: gen.used[gen.used.length - 1] });
    }
    logEvent(result.source === "ai" ? "info" : "warn", "cv_tailored", { source: result.source, models: gen?.used || [], rejected: result.rejected.length, analysis: analysis.source, ...(result.error ? { error: aiErrorSummary(result.error) } : {}) });

    return res.json({
      template,
      overleafUrl: "https://www.overleaf.com/docs",
      matchScore: match.score,
      matchedKeywords: match.matchedKeywords,
      missingKeywords: match.missingKeywords,
      source: result.source === "ai" ? "gemini-pipeline" : "profile-template",
      model: gen?.used[gen.used.length - 1],
      notice: notices.join(" ") || undefined,
      latexCode,
      tailored: result.tailored,
      analysis,
      rejected: result.rejected,
      highlights: result.tailored.highlights.length ? result.tailored.highlights : ["CV construit à partir de votre profil", "Aucune donnée ajoutée hors de votre profil"]
    });
  });

  // 3 bis. Mise en forme d'un contenu (édité par l'utilisateur) : aucun appel IA, instantané
  app.post("/api/tailor/render", (req, res) => {
    const { candidate, job } = req.body || {};
    const template = normalizeTemplate(req.body?.template ?? candidate?.preferredTemplate);
    const tailored = sanitizeTailored(req.body?.tailored) || defaultTailored(candidate, job);
    return res.json({ template, latexCode: generateFallbackLatex(applyTailored(candidate, tailored), job, template, { tailored: true }) });
  });

  // 3 bis bis. Mise en forme de la lettre de motivation : aucun appel IA
  app.post("/api/tailor/render-letter", (req, res) => {
    const { candidate, job } = req.body || {};
    const letter = String(req.body?.letter || "").slice(0, 12_000);
    if (!letter.trim()) return res.status(400).json({ success: false, error: "Lettre vide : rédigez ou générez la lettre d'abord." });
    return res.json({ latexCode: generateLetterLatex(candidate, job, letter) });
  });

  // 3 ter. Retouche ciblée d'une puce, de l'accroche ou du titre
  app.post("/api/tailor/rewrite", requireQuota("rewrite"), async (req: any, res) => {
    const { candidate, job, text, instruction } = req.body || {};
    const kind = ["bullet", "summary", "headline"].includes(req.body?.kind) ? req.body.kind : "bullet";
    if (!String(text || "").trim()) return res.status(400).json({ success: false, error: "Texte à retoucher manquant." });
    const ai = getGeminiClient();
    if (!ai) return res.status(503).json({ success: false, error: "Service IA indisponible : modifiez le texte à la main." });
    try {
      const { generate, used } = makeGenerate(ai, { allowBest: req.plan === "premium" });
      const out = await rewriteText(generate, candidate, job, String(text), String(instruction || ""), kind);
      return res.json({
        success: true,
        text: out.text,
        model: used[used.length - 1],
        rejected: out.rejected ? `Proposition écartée : ${out.rejected}. Le texte d'origine est conservé.` : undefined
      });
    } catch (e: any) {
      return res.status(502).json({ success: false, error: isRateLimitOrQuotaError(e) ? "L'assistant IA est très sollicité en ce moment : réessayez dans quelques minutes, ou modifiez le texte à la main." : "L'assistant IA n'a pas répondu. Réessayez, ou modifiez le texte à la main." });
    }
  });

  // 4. Lettre de motivation
  app.post("/api/tailor/letter", requireQuota("letter"), async (req: any, res) => {
    const { candidate, job } = req.body || {};
    const out = await writeLetter(candidate, job, { premium: req.plan === "premium", analysis: req.body?.analysis });
    if (out.source !== "ai") {
      res.locals.noCharge = true; // lettre modèle : non décomptée
      return res.json({ source: "standard-template", notice: out.notice, letter: out.letter });
    }
    return res.json({ source: "gemini-ai", letter: out.letter });
  });

  // 4 bis. Email de relance
  app.post("/api/tailor/followup", async (req, res) => {
    const { candidate, application } = req.body || {};
    const company = String(application?.company || "votre entreprise");
    const jobTitle = String(application?.jobTitle || "le poste");
    const appliedOn = application?.appliedAt ? new Date(application.appliedAt).toLocaleDateString("fr-FR") : "récemment";
    const count = Number(application?.followUpCount || 0);
    const name = String(candidate?.fullName || "");

    const template = () => ({
      source: "standard-template",
      subject: `Suivi de ma candidature – ${jobTitle}`,
      body: `Madame, Monsieur,

Le ${appliedOn}, je vous ai adressé ma candidature pour le poste de ${jobTitle} au sein de ${company}.
${count > 0 ? "Je me permets de revenir vers vous une nouvelle fois" : "Je me permets de revenir vers vous"} afin de savoir si ma candidature a pu être étudiée. Ce poste m'intéresse toujours vivement et je reste disponible pour un échange à votre convenance.

Je vous remercie par avance pour votre retour.

Cordialement,
${name}`.trim()
    });

    const ai = getGeminiClient();
    if (!ai) return res.json(template());
    try {
      const prompt = `Rédige un court email de relance (français, 80 à 120 mots, ton courtois et direct) pour une candidature sans réponse.
Poste : ${jobTitle} chez ${company}. Candidature envoyée le ${appliedOn}. Relances déjà envoyées : ${count}.
Candidat : ${candidateBrief(candidate)}
Mentionne au plus UN élément concret et réel du profil en lien avec le poste. N'invente rien.
Renvoie uniquement un JSON : { "subject": "objet", "body": "texte de l'email signé ${name || "par le candidat"}" }`;
      const response = await callGeminiResilient(ai, { preferredModel: MODEL_FAST, contents: prompt });
      const parsed = extractJsonObject(response.text || "");
      if (parsed?.subject && parsed?.body) return res.json({ source: "gemini-ai", subject: String(parsed.subject), body: String(parsed.body) });
      return res.json(template());
    } catch {
      return res.json(template());
    }
  });
}
