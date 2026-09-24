import type { Express } from "express";
import { extractTextFromPdf } from "../../src/semanticCvParser.ts";
import { extractTextFromDocx } from "../docx.ts";
import { analyzeCvForAts, countPdfPages, matchCvToOffer, type CvInputMeta } from "../atsCheck.ts";
import { logEvent } from "../log.ts";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
}
