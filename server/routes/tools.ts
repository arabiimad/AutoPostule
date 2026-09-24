import type { Express } from "express";
import { createHash } from "node:crypto";
import { extractSkillMentions } from "../../src/semanticCvParser.ts";
import { assessFit, candidateHasSkill, isFarFromProfile } from "../../src/utils/skillMatcher.ts";
import { tailorCv, experienceId } from "../cvPipeline.ts";
import { friendlyAiError, getGeminiClient, makeGenerate, cachedOfferAnalysis } from "../ai.ts";
import { stripApplicationInstructions } from "../jobSources.ts";
import { hasItems } from "../fallbacks.ts";
import { logEvent } from "../log.ts";
import { requireQuota } from "../plans.ts";

type Change = { where: string; kind: "headline" | "summary" | "bullet" | "hide"; before: string; after: string };

const norm = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Première ligne utile de l'offre collée (souvent l'intitulé du poste). */
function guessTitle(text: string): string {
  const line = String(text || "").split(/\n/).map((l) => l.trim()).find((l) => l.length >= 3 && l.length <= 120);
  return line || "Offre collée";
}

/**
 * Outil « Adapter mon CV à cette offre » : l'utilisateur colle n'importe quelle offre (LinkedIn, Indeed…).
 * Renvoie l'adéquation, les mots-clés de l'offre classés (présents / à nommer / absents) et la liste
 * des modifications concrètes proposées (avant → après), sans rien inventer (mêmes garde-fous que le Studio).
 */
export function registerToolRoutes(app: Express) {
  app.post("/api/tools/offer-match", requireQuota("cv"), async (req: any, res) => {
    const { candidate } = req.body || {};
    const offerText = String(req.body?.offerText || "").slice(0, 15000).trim();
    if (offerText.length < 80) {
      return res.status(400).json({ success: false, error: "Collez le texte complet de l'offre (missions, profil recherché)." });
    }
    if (!hasItems(candidate?.experiences)) {
      return res.status(400).json({ success: false, error: "PROFIL_INCOMPLET", message: "Importez d'abord votre CV : l'analyse compare l'offre à votre parcours." });
    }

    const title = String(req.body?.offerTitle || "").trim().slice(0, 120) || guessTitle(offerText);
    const company = String(req.body?.company || "").trim().slice(0, 120);
    const job = {
      id: `colle-${createHash("sha1").update(offerText).digest("hex").slice(0, 10)}`,
      title,
      company: company || "Entreprise",
      location: "",
      contractType: "cdi",
      remote: "sur-site",
      description: offerText,
      // Termes tels qu'écrits dans l'offre (« Docker », pas le groupe « Docker & Kubernetes »)
      skillsRequired: extractSkillMentions(`${title}\n${stripApplicationInstructions(offerText)}`),
      source: "Offre collée",
      origin: "manual",
      applyUrl: "",
      status: "active"
    };

    const ai = getGeminiClient();
    const gen = ai ? makeGenerate(ai, { allowBest: req.plan === "premium" }) : null;
    const analysis = await cachedOfferAnalysis(gen?.generate || null, job);
    const result = await tailorCv(gen?.generate || null, candidate, job, analysis);
    if (result.source !== "ai") res.locals.noCharge = true;
    const far = isFarFromProfile(candidate, job);
    if (far && candidate?.title) result.tailored.headline = String(candidate.title);

    // Mots-clés de l'offre : ceux des compétences reconnues + ceux jugés indispensables par l'analyse
    const keywords = Array.from(new Set([...job.skillsRequired, ...(analysis.mustHave || []), ...(analysis.keywords || [])]
      .map((k) => String(k).trim()).filter((k) => k.length >= 2 && k.length <= 60))).slice(0, 20);
    const skills: string[] = candidate?.skills || [];
    const profileText = norm([
      candidate?.title, candidate?.summary,
      ...(candidate?.experiences || []).flatMap((e: any) => [e?.title, ...(e?.bullets || []), ...(e?.technologies || [])]),
      ...(candidate?.projects || []).flatMap((p: any) => [p?.name, p?.description, ...(p?.technologies || [])])
    ].join(" "));
    const present: string[] = [], implicit: string[] = [], absent: string[] = [];
    for (const k of keywords) {
      if (candidateHasSkill(skills, k)) present.push(k);
      else if (norm(k).length >= 3 && profileText.includes(norm(k))) implicit.push(k);
      else absent.push(k);
    }

    // Modifications proposées : uniquement ce qui change réellement
    const changes: Change[] = [];
    const t = result.tailored;
    if (t.headline && norm(t.headline) !== norm(candidate?.title || "")) changes.push({ where: "Titre du CV", kind: "headline", before: String(candidate?.title || ""), after: t.headline });
    if (t.summary && norm(t.summary) !== norm(candidate?.summary || "")) changes.push({ where: "Accroche", kind: "summary", before: String(candidate?.summary || ""), after: t.summary });
    (candidate?.experiences || []).forEach((e: any, i: number) => {
      const te = t.experiences.find((x) => x.id === experienceId(e, i));
      const where = [e?.title, e?.company].filter(Boolean).join(" · ") || `Expérience ${i + 1}`;
      if (!te) return;
      if (!te.include) {
        changes.push({ where, kind: "hide", before: where, after: "" });
        return;
      }
      const original: string[] = e?.bullets || [];
      te.bullets.forEach((b, bi) => {
        const before = original[bi] || "";
        if (b && norm(b) !== norm(before)) changes.push({ where, kind: "bullet", before, after: b });
      });
    });

    const notices: string[] = [];
    if (!ai) notices.push("Service d'IA indisponible : seuls les mots-clés sont analysés.");
    else if (result.source !== "ai") notices.push(`Reformulations indisponibles (${friendlyAiError(result.error)}) : seuls les mots-clés sont analysés.`);
    if (far) notices.push("Cette offre semble éloignée de votre parcours : vérifiez qu'elle vous correspond avant de postuler.");
    if (result.rejected.length) {
      const n = result.rejected.length;
      notices.push(n === 1 ? "Une reformulation a été écartée car elle ajoutait des éléments absents de votre profil." : `${n} reformulations ont été écartées car elles ajoutaient des éléments absents de votre profil.`);
    }
    logEvent("info", "offer_match", { source: result.source, changes: changes.length, keywords: keywords.length });

    return res.json({
      success: true,
      job,
      analysis,
      fit: assessFit(candidate, job),
      keywords: { present, implicit, absent },
      changes: changes.slice(0, 30),
      skillsOrder: t.skillsOrder.slice(0, 8),
      tailored: t,
      notice: notices.join(" ") || undefined
    });
  });
}
