import type { Express } from "express";
import { extractTextFromPdf, extractSkillMentions } from "../../src/semanticCvParser.ts";
import { extractTextFromDocx } from "../docx.ts";
import { analyzeCvForAts, countPdfPages, matchCvToOffer, type CvInputMeta } from "../atsCheck.ts";
import { logEvent } from "../log.ts";
import { createHash } from "node:crypto";
import { assessFit, candidateHasSkill, isFarFromProfile } from "../../src/utils/skillMatcher.ts";
import { tailorCv, experienceId } from "../cvPipeline.ts";
import { friendlyAiError, getGeminiClient, makeGenerate, cachedOfferAnalysis } from "../ai.ts";
import { stripApplicationInstructions } from "../jobSources.ts";
import { hasItems } from "../fallbacks.ts";
import { requireQuota } from "../plans.ts";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
type DocInput = { text: string; meta: CvInputMeta } | { error: string; status: number };

/** Champs d'un document dans la requête : `fileBase64`, `mimeType`, `fileName` et le texte collé. */
interface DocFields { file: string; mime: string; name: string; text: string; maxText: number; what: string }

/** Document fourni en fichier (PDF, Word, texte) ou en texte collé → texte brut. Rien n'est conservé. */
async function readDocument(body: any, f: DocFields): Promise<DocInput> {
  const pasted = typeof body?.[f.text] === "string" ? body[f.text].slice(0, f.maxText) : "";
  const b64 = typeof body?.[f.file] === "string" ? body[f.file].replace(/^data:[^;]+;base64,/, "") : "";
  if (!b64) {
    return pasted.trim() ? { text: pasted, meta: { format: "text" } } : { error: `Déposez ${f.what} (PDF, Word ou texte) ou collez son contenu.`, status: 400 };
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length > MAX_FILE_BYTES) return { error: "Fichier trop volumineux (8 Mo maximum).", status: 413 };
  const mime = String(body?.[f.mime] || "").toLowerCase();
  const name = String(body?.[f.name] || "").toLowerCase();
  const isPdf = mime === "application/pdf" || buf.subarray(0, 5).toString("latin1") === "%PDF-";
  const isDocx = mime === DOCX_MIME || name.endsWith(".docx");
  const isTxt = mime === "text/plain" || name.endsWith(".txt");
  try {
    if (isPdf) return { text: await extractTextFromPdf(buf), meta: { format: "pdf", pages: countPdfPages(buf) } };
    if (isDocx) return { text: extractTextFromDocx(buf), meta: { format: "docx" } };
    if (isTxt) return { text: buf.toString("utf8").slice(0, f.maxText), meta: { format: "text" } };
  } catch {
    return { error: `Ce fichier est illisible. Enregistrez-le à nouveau en PDF, ou collez le contenu de ${f.what}.`, status: 422 };
  }
  return { error: "Format non pris en charge : déposez un PDF, un document Word (.docx) ou un fichier texte (.txt).", status: 415 };
}

/** CV : `fileBase64`, `mimeType`, `fileName` ou `cvText`. */
export const readCvInput = (body: any) =>
  readDocument(body, { file: "fileBase64", mime: "mimeType", name: "fileName", text: "cvText", maxText: 60_000, what: "votre CV" });

/** Offre : `offerFileBase64`, `offerMimeType`, `offerFileName` ou `offerText`. */
export const readOfferInput = (body: any) =>
  readDocument(body, { file: "offerFileBase64", mime: "offerMimeType", name: "offerFileName", text: "offerText", maxText: 30_000, what: "l'offre" });

/** Outils publics : aucun compte, aucun quota, aucune IA (limite de débit par IP dans app.ts). */
export function registerToolRoutes(app: Express) {
  app.post("/api/tools/ats-check", async (req, res) => {
    const input = await readCvInput(req.body);
    if ("error" in input) return res.status(input.status).json({ success: false, error: input.error });
    const report = analyzeCvForAts(input.text, input.meta);
    // Journal : chiffres seulement, jamais le contenu du CV
    logEvent("info", "tool_ats_check", { format: input.meta.format, score: report.score, words: report.stats.words });
    return res.json({ success: true, ...report });
  });

  app.post("/api/tools/match", async (req, res) => {
    const offer = await readOfferInput(req.body);
    if ("error" in offer) return res.status(offer.status).json({ success: false, error: offer.error });
    const offerText = offer.text;
    if (offerText.trim().length < 40) return res.status(422).json({ success: false, error: "L'offre est trop courte ou illisible : il faut son texte complet (missions, profil recherché)." });
    const input = await readCvInput(req.body);
    if ("error" in input) return res.status(input.status).json({ success: false, error: input.error });
    const match = matchCvToOffer(input.text, offerText);
    const ats = analyzeCvForAts(input.text, input.meta);
    logEvent("info", "tool_match", { format: input.meta.format, offerFormat: offer.meta.format, score: match.score, keywords: match.keywords.length });
    return res.json({ success: true, ...match, ats: { score: ats.score, level: ats.level } });
  });

  // Outil du compte (IA, quota « cv ») : « Adapter mon CV à cette offre » à partir du profil enregistré
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
