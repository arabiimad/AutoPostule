import type { Express } from "express";
import { extractTextFromPdf, parseCvSemantically, isParsedCvEmpty } from "../../src/semanticCvParser.ts";
import { extractTextFromDocx } from "../docx.ts";
import { renderCvHtml, generatePdfFromHtml, isWebPdfAvailable } from "../pdf.ts";
import { normalizeTemplate } from "../latex.ts";
import { applyTailored, sanitizeTailored } from "../cvPipeline.ts";
import { getGeminiClient, callGeminiResilient, extractJsonObject, MODEL_FAST } from "../ai.ts";
import { hasItems } from "../fallbacks.ts";
import { logEvent } from "../log.ts";

const SUPPORTED_AI_MIME = /^(application\/pdf|image\/(png|jpeg|webp))$/i;

export function registerCvRoutes(app: Express) {
  // 0. Analyse du CV
  app.post("/api/cv/analyze", async (req, res) => {
    const { fileBase64, mimeType, cvText } = req.body || {};
    const unreadable = (message: string) => res.status(422).json({ success: false, error: message });

    try {
      const ai = getGeminiClient();
      const base64Data = typeof fileBase64 === "string" ? fileBase64.replace(/^data:[^;]+;base64,/, "") : "";
      const actualMime = String(mimeType || "").toLowerCase();
      const isPdf = actualMime === "application/pdf";
      const isDocx = actualMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

      // Extraction texte locale : uniquement pour les PDF (un .docx ou une image donnerait du binaire illisible)
      let extractedBufferText = "";
      if (base64Data && isPdf) {
        try {
          extractedBufferText = await extractTextFromPdf(Buffer.from(base64Data, "base64"));
        } catch (bufErr) {
          console.log("[CV Parser] Extraction PDF impossible:", bufErr);
        }
      }
      if (base64Data && isDocx) {
        try {
          extractedBufferText = extractTextFromDocx(Buffer.from(base64Data, "base64"));
        } catch (docErr: any) {
          return unreadable("Ce document Word est illisible. Enregistrez-le en PDF ou collez le texte de votre CV.");
        }
      }
      const effectiveText = (typeof cvText === "string" && cvText.trim()) || extractedBufferText;

      if (base64Data && !isDocx && !SUPPORTED_AI_MIME.test(actualMime)) {
        return unreadable("Format non pris en charge. Déposez un PDF, un document Word (.docx) ou une image PNG/JPEG, ou collez le texte de votre CV.");
      }
      if (base64Data && !isPdf && !isDocx && !ai) {
        return unreadable("La lecture des images nécessite le service IA, actuellement indisponible. Déposez un PDF ou collez le texte de votre CV.");
      }

      const prompt = `Tu es un expert mondial en recrutement et en analyse de CV pour tous métiers et secteurs d'activité (Marketing, Ressources Humaines, Finance, Commerce, Logistique, Juridique, Santé, Ingénierie, Hôtellerie, Design, Administration, Tech, etc.).
Ta mission est d'analyser le CV fourni et d'en extraire avec une exactitude chirurgicale TOUTES les informations RÉELLES du candidat, SANS RIEN INVENTER.

Tu dois renvoyer STRICTEMENT un objet JSON valide (aucun texte d'accompagnement, aucune phrase avant ou après) respectant la structure suivante :
{
  "fullName": "Nom et prénom extraits du CV",
  "email": "Adresse email ou chaîne vide",
  "phone": "Numéro de téléphone ou chaîne vide",
  "title": "Titre professionnel principal affiché ou déduit du profil (ex: Chargé de Recrutement RH, Chef de Projet Marketing, Contrôleur de Gestion, Développeur...)",
  "location": "Ville, région ou pays mentionné (ex: Paris, France)",
  "linkedinUrl": "Lien ou identifiant LinkedIn si présent, sinon chaîne vide",
  "githubUrl": "Lien portfolio / GitHub / site pro si présent, sinon chaîne vide",
  "portfolioUrl": "Lien site web / portfolio si présent, sinon chaîne vide",
  "summary": "Synthèse professionnelle ou accroche rédigée présente sur le CV (2-3 phrases fidèles)",
  "skills": ["Compétence 1", "Compétence 2", "Compétence 3"],
  "experiences": [
    {
      "id": "exp-1",
      "title": "Intitulé du poste",
      "company": "Nom de l'entreprise ou organisme",
      "location": "Ville ou télétravail",
      "startDate": "Date de début (ex: 2023 ou Mars 2023)",
      "endDate": "Date de fin ou Présent",
      "current": true,
      "bullets": [
        "Réalisation ou mission concrète 1",
        "Réalisation concrète 2"
      ],
      "technologies": ["Compétence / Outil clé 1", "Outil 2"]
    }
  ],
  "education": [
    {
      "id": "edu-1",
      "degree": "Intitulé du diplôme ou formation",
      "institution": "Établissement, École ou Université",
      "year": "Année d'obtention ou période",
      "details": "Spécialisation, mention ou détails si indiqués"
    }
  ],
  "projects": [
    {
      "id": "proj-1",
      "name": "Nom du projet ou réalisation",
      "description": "Description succincte",
      "technologies": ["Compétence / Outil 1", "Outil 2"],
      "link": "Lien si mentionné"
    }
  ],
  "languages": ["Français (Natif/Courant)", "Anglais (B2/C1)"],
  "targetRoles": ["Rôle ciblé 1", "Rôle ciblé 2"]
}

RÈGLES D'OR ABSOLUES :
1. Reste 100% fidèle au document original. Ne génère AUCUNE donnée fictive, aucun nom d'entreprise imaginaire.
2. Si un champ n'est pas présent dans le CV, laisse le champ vide ("" ou []).
3. Normalise les compétences sous forme de mots-clés propres et exploitables adaptés au domaine du candidat (ex: "Recrutement", "Paie", "Excel avancé", "Négociation", "SEO", "Gestion de budget", "Python", etc.).`;

      let responseText = "";

      // Le .docx n'est pas lu directement par l'IA : on lui envoie le texte extrait
      if (ai && base64Data && !isDocx) {
        try {
          const response = await callGeminiResilient(ai, {
            preferredModel: MODEL_FAST,
            contents: [{ inlineData: { mimeType: actualMime, data: base64Data } }, { text: prompt }]
          });
          responseText = response?.text || "";
        } catch (multiModalErr: any) {
          console.log("[CV Parser] Analyse multimodale:", multiModalErr?.status || String(multiModalErr?.message || "").slice(0, 80));
        }
      }

      if (ai && !responseText && effectiveText) {
        try {
          const response = await callGeminiResilient(ai, {
            preferredModel: MODEL_FAST,
            contents: `${prompt}\n\n=== CONTENU DU CV À PARSER ===\n${effectiveText}`
          });
          responseText = response?.text || "";
        } catch (textErr: any) {
          console.log("[CV Parser] Analyse texte:", textErr?.status || String(textErr?.message || "").slice(0, 80));
        }
      }

      const parsed = extractJsonObject(responseText);
      if (parsed && (parsed.fullName || (Array.isArray(parsed.skills) && parsed.skills.length > 0))) {
        return res.json({ success: true, source: "gemini-ai", profile: parsed });
      }

      // Secours : analyseur local, uniquement sur du vrai texte
      if (effectiveText && effectiveText.trim().length > 30) {
        const fallbackParsed = parseCvSemantically(effectiveText);
        if (!isParsedCvEmpty(fallbackParsed)) {
          return res.json({ success: true, source: "heuristic-parser", profile: fallbackParsed });
        }
      }

      return unreadable("Impossible de lire ce CV. Vérifiez que le PDF contient du texte sélectionnable, ou collez le texte de votre CV.");
    } catch (error: any) {
      console.error("[CV Parser] Erreur:", error?.message || error);
      return res.status(500).json({ success: false, error: "Erreur lors de l'analyse du CV. Réessayez." });
    }
  });

  // Rendu « Web » du CV (HTML → PDF par Chromium) : ne nécessite pas LaTeX sur le serveur
  const tailoredCandidate = (body: any) => {
    const tailored = sanitizeTailored(body?.tailored);
    return { candidate: tailored ? applyTailored(body?.candidate, tailored) : body?.candidate, tailored: !!tailored };
  };
  app.post("/api/cv/html", (req, res) => {
    const { job, sector } = req.body || {};
    const { candidate, tailored } = tailoredCandidate(req.body);
    if (!hasItems(candidate?.experiences)) return res.status(400).json({ error: "PROFIL_INCOMPLET", message: "Ajoutez au moins une expérience à votre profil." });
    const html = renderCvHtml(candidate, job, normalizeTemplate(req.body?.template), sector || job?.domain || job?.companySector, undefined, { tailored });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  });
  app.post("/api/cv/pdf", async (req, res) => {
    const { job, sector } = req.body || {};
    const { candidate, tailored } = tailoredCandidate(req.body);
    if (!hasItems(candidate?.experiences)) return res.status(400).json({ error: "PROFIL_INCOMPLET", message: "Ajoutez au moins une expérience à votre profil." });
    if (!(await isWebPdfAvailable())) return res.status(501).json({ error: "WEB_PDF_UNAVAILABLE", message: "Le moteur PDF (Chromium) n'est pas installé sur le serveur : utilisez le rendu LaTeX ou Overleaf." });
    try {
      const html = renderCvHtml(candidate, job, normalizeTemplate(req.body?.template), sector || job?.domain || job?.companySector, undefined, { tailored });
      const pdf = await generatePdfFromHtml(html);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'inline; filename="cv.pdf"');
      return res.send(pdf);
    } catch (e: any) {
      logEvent("error", "web_pdf_failed", { message: String(e?.message || e).slice(0, 300) });
      return res.status(500).json({ error: "PDF_GENERATION_FAILED", message: "Génération du PDF impossible. Réessayez." });
    }
  });
}
