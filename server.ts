import express from "express";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { extractTextFromPdf, parseCvSemantically, isParsedCvEmpty } from "./src/semanticCvParser.ts";
import { COMPREHENSIVE_REAL_JOBS } from "./src/realJobsData.ts";
import { filterJobs } from "./src/utils/jobFilter.ts";
import { calculateCandidateMatch } from "./src/utils/skillMatcher.ts";
import { searchRealJobs, hasRealSources, getSourceStatus } from "./server/jobSources.ts";
import { generateFallbackLatex, normalizeTemplate, templateInstructions, compileLatex, detectLatexCompiler, TEMPLATES } from "./server/latex.ts";
import { authMiddleware, getAuthMode } from "./server/auth.ts";
import { extractTextFromDocx } from "./server/docx.ts";
import { kv, countApiCall, getQuotaUsage } from "./server/store.ts";
import { createHash } from "node:crypto";
import {
  analyzeOffer, tailorCv, applyTailored, sanitizeTailored, rewriteText, fallbackOfferAnalysis, defaultTailored,
  type GenerateFn, type OfferAnalysis
} from "./server/cvPipeline.ts";

dotenv.config();

// Modèles Gemini : le plus puissant pour rédiger (CV, lettre, retouches), le rapide pour analyser.
// Les modèles Pro exigent un projet Google Cloud avec facturation activée : sinon repli automatique sur Flash.
const MODEL_BEST = process.env.GEMINI_MODEL_BEST || "gemini-3.1-pro-preview";
const MODEL_FAST = process.env.GEMINI_MODEL_FAST || "gemini-3.8-flash";
const MODEL_FALLBACKS = ["gemini-3.6-flash", "gemini-3.5-flash"];
/** Modèles indisponibles pour cette clé (facturation, accès) : évités pendant une heure. */
const unavailableModels = new Map<string, number>();

// Port fourni par l'hébergeur (Cloud Run, Render…) ; 3000 en local
const PORT = Number(process.env.PORT) || 3000;

/** Journal structuré (une ligne JSON) : lisible par Cloud Logging, Datadog, Grafana Loki… */
function logEvent(level: "info" | "warn" | "error", event: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...data });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function getGeminiClient(): GoogleGenAI | null {
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

// Base d'offres de DÉMONSTRATION : utilisée seulement si aucune source réelle n'est configurée.
const DEMO_OFFERS = COMPREHENSIVE_REAL_JOBS.map((j) => ({ ...j, origin: "demo" as const }));

function isRateLimitOrQuotaError(error: any): boolean {
  if (!error) return false;
  const str = String(error?.message || error?.status || error?.code || error);
  return (
    str.includes("429") ||
    str.includes("503") ||
    str.includes("RESOURCE_EXHAUSTED") ||
    str.includes("UNAVAILABLE") ||
    str.includes("quota") ||
    str.includes("high demand") ||
    str.includes("rate-limits") ||
    str.includes("rate limit") ||
    str.includes("overloaded")
  );
}

/** Âge (en jours) des libellés de la base de démo : « Hier », « Il y a 3 jours »… */
function demoAgeInDays(label: string): number {
  if (/hier/i.test(label)) return 1;
  const m = label.match(/(\d+)\s*jour/i);
  return m ? Number(m[1]) : 0;
}

function searchLocalJobs(query?: string, contractType?: string, location?: string) {
  const now = Date.now();
  // Dates recalculées à chaque requête : la démo ne « vieillit » pas
  return filterJobs(DEMO_OFFERS, { query, contractType, location }).map((j) => ({
    ...j,
    publishedAt: new Date(now - demoAgeInDays(String(j.publishedAt || "")) * 86_400_000).toISOString(),
    lastVerifiedAt: undefined
  }));
}

function hasItems(v: any): v is any[] {
  return Array.isArray(v) && v.length > 0;
}

function generateFallbackLetter(candidate: any, job: any): string {
  const candidateName = candidate?.fullName || "";
  const jobTitle = job?.title || "le poste proposé";
  const company = job?.company || "votre structure";
  const matched = calculateCandidateMatch(candidate?.skills || [], job?.skillsRequired || []).matchedKeywords;
  const skillsSentence = matched.length > 0
    ? `Mon parcours m'a permis de développer des compétences directement utiles pour ce poste, notamment : ${matched.slice(0, 3).join(", ")}.`
    : `Mon parcours m'a permis de développer des compétences que je serais heureux(se) de mettre au service de ${company}.`;
  const lastExp = hasItems(candidate?.experiences) ? candidate.experiences[0] : null;
  const expSentence = lastExp?.title && lastExp?.company
    ? `\n\nEn tant que ${lastExp.title} chez ${lastExp.company}, ${lastExp.bullets?.[0] ? `j'ai notamment été en charge de la mission suivante : ${String(lastExp.bullets[0]).replace(/\.$/, "").replace(/^./, (c: string) => c.toLowerCase())}.` : "j'ai pu mettre en pratique ces compétences au quotidien."}`
    : "";

  const opening = job?.isSpontaneous
    ? `Je vous adresse une candidature spontanée pour un contrat en alternance au sein de ${company}${job?.companySector ? `, dont l'activité (${String(job.companySector).toLowerCase()}) m'intéresse particulièrement` : ""}.`
    : `Je vous adresse ma candidature pour le poste de ${jobTitle} au sein de ${company}.`;

  return `Madame, Monsieur,

${opening}

${skillsSentence}${expSentence}

Je serais ravi(e) d'échanger avec vous lors d'un entretien afin de vous présenter plus en détail ma motivation.

Je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées.
${candidateName ? `\n${candidateName}` : ""}`;
}

function generateFallbackPrepKit(candidate: any, job: any) {
  const company = job?.company || "L'entreprise";
  const jobTitle = job?.title || "Poste ciblé";
  const skills: string[] = hasItems(job?.skillsRequired) ? job.skillsRequired : (candidate?.skills || []);

  return {
    generic: true,
    companySynthesis: {
      summary: `Synthèse non disponible (IA hors ligne). Renseignez-vous sur ${company} : activité, actualité récente, valeurs affichées sur son site carrières.`,
      coreChallenges: [
        `Comprendre les missions concrètes du poste de ${jobTitle}`,
        "Identifier les outils et méthodes utilisés par l'équipe",
        "Relier vos expériences aux besoins exprimés dans l'offre"
      ],
      techStackAnticipated: skills.slice(0, 5),
      culturalValues: []
    },
    elevatorPitch: `Trame (à personnaliser) : « Bonjour, je suis ${candidate?.fullName || "[votre nom]"}, ${candidate?.title || "[votre titre]"}. [Votre expérience la plus pertinente en une phrase]. Ce qui m'attire chez ${company}, c'est [élément précis de l'offre ou de l'entreprise]. »`,
    topQuestions: [
      {
        question: "Pouvez-vous me présenter une réalisation ou un projet récent dont vous êtes particulièrement fier(e) ?",
        category: "Projet",
        whyTheyAsk: "Évaluer la profondeur de vos compétences et votre impact concret.",
        suggestedAnswer: "Structurez votre réponse avec la méthode STAR (Situation, Tâche, Action, Résultat mesurable).",
        keyPoints: ["Contexte initial", "Vos actions personnelles", "Un résultat chiffré"]
      },
      {
        question: `Pourquoi souhaitez-vous rejoindre ${company} ?`,
        category: "Motivation",
        whyTheyAsk: "Vérifier votre préparation et l'alignement avec l'entreprise.",
        suggestedAnswer: "Citez un élément précis de l'entreprise et reliez-le à votre projet professionnel.",
        keyPoints: ["Un élément distinctif de l'entreprise", "Le lien avec votre parcours"]
      },
      {
        question: "Comment gérez-vous les imprévus face à des échéances serrées ?",
        category: "Comportemental / Culture",
        whyTheyAsk: "Observer votre capacité à prioriser et à communiquer.",
        suggestedAnswer: "Donnez un exemple réel : priorisation, communication, solution trouvée.",
        keyPoints: ["Méthode", "Communication proactive", "Résultat"]
      }
    ],
    smartQuestionsToAskInterviewer: [
      `Quelle sera la priorité principale de la personne qui occupera le poste de ${jobTitle} durant ses premiers mois ?`,
      "Comment l'équipe est-elle organisée au quotidien ?",
      "Quelles sont les perspectives d'évolution sur ce poste ?"
    ]
  };
}

async function callGeminiResilient(
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
function extractJsonObject(text: string): any | null {
  const match = (text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Limiteur de débit par compte (ou IP), à fenêtre fixe. Partagé entre instances si Redis est configuré
 * (voir server/store.ts), sinon en mémoire.
 */
function createRateLimiter(name: string, maxRequests: number, windowMs: number) {
  return async (req: any, res: any, next: any) => {
    // Compte Firebase vérifié si disponible, sinon req.ip (et non l'en-tête X-Forwarded-For brut, falsifiable)
    const who = req.uid ? `uid:${req.uid}` : `ip:${String(req.ip || "unknown")}`;
    const windowIndex = Math.floor(Date.now() / windowMs);
    try {
      const count = await kv().incr(`rl:${name}:${who}:${windowIndex}`, Math.ceil(windowMs / 1000) + 1);
      if (count > maxRequests) {
        const retry = Math.ceil(((windowIndex + 1) * windowMs - Date.now()) / 1000);
        res.setHeader("Retry-After", Math.max(1, retry));
        return res.status(429).json({ success: false, error: "Trop de requêtes. Réessayez dans une minute." });
      }
    } catch {
      /* stockage indisponible : on ne bloque pas l'utilisateur */
    }
    next();
  };
}

/** Fonction d'appel à l'IA pour la chaîne de génération du CV ; `used` liste les modèles ayant répondu. */
function makeGenerate(ai: GoogleGenAI): { generate: GenerateFn; used: string[] } {
  const used: string[] = [];
  const generate: GenerateFn = async (prompt, { quality, json }) => {
    const r: any = await callGeminiResilient(ai, {
      preferredModel: quality === "best" ? MODEL_BEST : MODEL_FAST,
      contents: prompt,
      config: json ? { responseMimeType: "application/json", temperature: quality === "best" ? 0.4 : 0.1 } : undefined
    });
    if (r?.__model) used.push(r.__model);
    return r?.text || "";
  };
  return { generate, used };
}

/** Analyse d'offre mise en cache 7 jours (même offre = même analyse, un seul appel IA). */
async function cachedOfferAnalysis(generate: GenerateFn | null, job: any): Promise<OfferAnalysis> {
  const key = `offer:${createHash("sha1").update(`${job?.title}|${job?.company}|${String(job?.description || "").slice(0, 4000)}`).digest("hex")}`;
  const hit = await kv().get(key);
  if (hit) {
    try { return JSON.parse(hit); } catch { /* recalcul */ }
  }
  const analysis = await analyzeOffer(generate, job);
  if (analysis.source === "ai") await kv().set(key, JSON.stringify(analysis), 7 * 86400);
  return analysis;
}

function candidateBrief(candidate: any): string {
  const exps = (candidate?.experiences || []).map((e: any) => ({ poste: e.title, entreprise: e.company, periode: [e.startDate, e.endDate].filter(Boolean).join(" - "), realisations: e.bullets }));
  const edu = (candidate?.education || []).map((ed: any) => ({ diplome: ed.degree, etablissement: ed.institution, annee: ed.year }));
  return `Nom : ${candidate?.fullName || "(non renseigné)"}
Titre : ${candidate?.title || "(non renseigné)"}
Compétences : ${JSON.stringify(candidate?.skills || [])}
Expériences : ${JSON.stringify(exps)}
Formations : ${JSON.stringify(edu)}
Langues : ${JSON.stringify(candidate?.languages || [])}`;
}

function stableJobId(company: any, title: any, location: any): string {
  const key = [company, title, location].map((v) => String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim()).join("|");
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return `live-${h.toString(36)}`;
}

const SUPPORTED_AI_MIME = /^(application\/pdf|image\/(png|jpeg|webp))$/i;

async function startServer() {
  const app = express();
  // Un seul proxy devant l'application (Cloud Run / AI Studio) : req.ip = vraie IP du client
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "12mb" }));
  app.use(express.urlencoded({ extended: true, limit: "12mb" }));

  // Vérification du compte (AUTH_MODE) puis limite de débit : 30 appels IA / minute par compte ou par IP
  const PROTECTED = ["/api/cv", "/api/tailor", "/api/interview", "/api/latex/compile"];
  app.use(PROTECTED, authMiddleware());
  // Mise en forme sans IA (/api/tailor/render) : appelée à chaque retouche, limite plus large
  const iaLimiter = createRateLimiter("ia", 30, 60_000);
  const renderLimiter = createRateLimiter("render", 150, 60_000);
  app.use(PROTECTED, (req: any, res: any, next: any) =>
    (String(req.originalUrl).startsWith("/api/tailor/render") ? renderLimiter : iaLimiter)(req, res, next));
  // Recherche d'offres : quotas des API partenaires (60/min pour La bonne alternance), résultats en cache
  app.use("/api/jobs", createRateLimiter("jobs", 40, 60_000));
  app.use("/api/client-errors", createRateLimiter("errors", 20, 60_000));

  // Erreurs JavaScript remontées par le navigateur (suivi d'erreurs sans service tiers)
  app.post("/api/client-errors", (req, res) => {
    const b = req.body || {};
    logEvent("error", "client_error", {
      message: String(b.message || "").slice(0, 500),
      stack: String(b.stack || "").slice(0, 2000),
      url: String(b.url || "").slice(0, 300),
      userAgent: String(req.headers["user-agent"] || "").slice(0, 200),
      release: String(b.release || "")
    });
    res.status(204).end();
  });

  app.get("/api/health", async (req, res) => {
    res.json({
      status: "ok",
      ai: !!process.env.GEMINI_API_KEY,
      authMode: getAuthMode(),
      jobSources: getSourceStatus(),
      storage: kv().kind,
      latexCompiler: !!(await detectLatexCompiler())
    });
  });

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

  // 1. Recherche d'offres
  //    - sources réelles (La bonne alternance, France Travail) si des clés sont configurées ;
  //    - sinon base de démonstration (+ recherche web IA facultative, signalée comme telle).
  app.get("/api/jobs/sources", async (req, res) => {
    res.json({ ...getSourceStatus(), mode: hasRealSources() ? "live" : "demo", storage: kv().kind, quotas: await getQuotaUsage() });
  });

  const handleJobSearch = async (req: any, res: any) => {
    const { query, contractType, location, radius, page, includeSpontaneous } = req.body || {};
    const cleanQuery = String(query || "").trim().slice(0, 120);
    const cleanLocation = String(location || "").trim().slice(0, 80);
    const r = Number(radius);

    if (hasRealSources()) {
      try {
        const started = Date.now();
        const result = await searchRealJobs({
          query: cleanQuery,
          contractType,
          location: cleanLocation,
          radius: Number.isFinite(r) ? r : 30,
          page: Math.max(1, Math.min(Number(page) || 1, 20)),
          includeSpontaneous: includeSpontaneous !== false
        });
        // Quotas gratuits bientôt épuisés : l'utilisateur est prévenu
        try {
          const usage = await getQuotaUsage();
          const QUOTA_NAMES: Record<string, string> = { jsearch: "Google Jobs (JSearch)", adzuna: "Adzuna", jooble: "Jooble" };
          for (const [key, name] of Object.entries(QUOTA_NAMES)) {
            const q = (usage as any)[key];
            if (q?.limit && q.used >= q.limit * 0.8) {
              result.warnings.push(`Quota ${name} presque atteint : ${q.used}/${q.limit} requêtes ${q.period}.`);
            }
          }
        } catch { /* indicatif */ }
        logEvent("info", "job_search", {
          ms: Date.now() - started,
          page: result.page,
          total: result.jobs.length,
          sources: Object.fromEntries(Object.entries(result.sources).map(([k, v]) => [k, v.error ? `erreur` : v.skipped ? "ignorée" : v.count]))
        });
        return res.json({ success: true, mode: "live", total: result.jobs.length, ...result });
      } catch (e: any) {
        logEvent("error", "job_search_failed", { message: String(e?.message || e) });
        return res.status(502).json({ success: false, error: "Les sources d'offres ne répondent pas. Réessayez dans un instant." });
      }
    }

    // Mode démo : une seule page
    if (Number(page) > 1) return res.json({ success: true, mode: "demo", total: 0, jobs: [], hasMore: false });
    return handleDemoSearch(cleanQuery, contractType, cleanLocation, res);
  };
  app.post("/api/jobs/search", handleJobSearch);
  app.post("/api/jobs/search-live", handleJobSearch); // ancien nom conservé

  const handleDemoSearch = async (cleanQuery: string, contractType: any, location: string, res: any) => {
    const localMatches = searchLocalJobs(cleanQuery, contractType, location);
    const demoBase = { success: true, mode: "demo", warnings: ["Mode démonstration : offres indicatives. Configurez au moins une source d'offres dans .env (France Travail, La bonne alternance, JSearch, Adzuna ou Jooble — voir .env.example)."] };

    if (!cleanQuery || cleanQuery.toLowerCase() === "tous") {
      return res.json({ ...demoBase, total: localMatches.length, jobs: localMatches });
    }

    const ai = getGeminiClient();
    if (!ai) {
      return res.json({ ...demoBase, total: localMatches.length, jobs: localMatches });
    }

    try {
      const prompt = `Tu es un moteur d'ingestion d'offres d'emploi, de stages et d'alternances en temps réel.
Effectue une recherche sur les offres actuellement en ligne pour la requête : "${cleanQuery}" en "${location || 'France'}" avec type de contrat "${contractType || 'tous'}".
Trouve entre 4 et 8 offres RÉELLES et récentes.

Renvoie UNIQUEMENT un tableau JSON valide (sans backticks markdown si possible, ou dans un bloc json) avec la structure exacte suivante pour chaque élément :
[
  {
    "id": "job-live-unique-id",
    "title": "Intitulé exact du poste",
    "company": "Nom de l'entreprise",
    "location": "Ville ou télétravail",
    "contractType": "stage" ou "alternance" ou "cdi" ou "freelance" ou "cdd",
    "remote": "hybride" ou "total" ou "sur-site",
    "salary": "Salaire estimé ou À négocier",
    "description": "Résumé en 2-3 phrases des missions principales",
    "skillsRequired": ["compétence 1", "compétence 2", "compétence 3", "compétence 4"],
    "source": "Indeed France" ou "France Travail" ou "Welcome to the Jungle" ou "LinkedIn",
    "applyUrl": "URL de candidature réelle",
    "publishedAt": "Aujourd'hui"
  }
]`;

      const searchPromise = callGeminiResilient(ai, {
        preferredModel: MODEL_FAST,
        contents: prompt,
        config: { tools: [{ googleSearch: {} }] }
      });
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("SEARCH_TIMEOUT")), 15000);
      });
      const response = await Promise.race([searchPromise, timeoutPromise]).finally(() => timer && clearTimeout(timer));

      const text = response.text || "";
      const jsonMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
      let liveJobs: any[] = [];
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed)) {
            const allowedContracts = ["stage", "alternance", "cdi", "cdd", "freelance"];
            const allowedRemote = ["total", "hybride", "sur-site"];
            liveJobs = parsed
              .filter((j: any) => j && j.title && j.company)
              .map((j: any) => ({
                // Identifiant stable : la même offre retrouvée plus tard garde le même id (pas de dossier en double)
                id: stableJobId(j.company, j.title, j.location),
                title: String(j.title),
                company: String(j.company),
                location: String(j.location || location || "France"),
                contractType: allowedContracts.includes(String(j.contractType).toLowerCase()) ? String(j.contractType).toLowerCase() : "cdi",
                remote: allowedRemote.includes(String(j.remote).toLowerCase()) ? String(j.remote).toLowerCase() : "sur-site",
                salary: j.salary ? String(j.salary) : undefined,
                description: String(j.description || ""),
                skillsRequired: Array.isArray(j.skillsRequired) ? j.skillsRequired.map(String) : [],
                source: `${j.source || "Web"} (recherche IA, à vérifier)`,
                origin: "ia-web",
                applyUrl: typeof j.applyUrl === "string" ? j.applyUrl : "",
                publishedAt: j.publishedAt || new Date().toISOString().split("T")[0],
                status: "active",
                domain: "Recherche web"
              }));
          }
        } catch {
          // JSON invalide : on garde la base locale
        }
      }

      const combined = [...liveJobs, ...localMatches];
      return res.json({ ...demoBase, total: combined.length, jobs: combined });
    } catch (error: any) {
      console.log("[Recherche] Recherche web indisponible, base de démo servie:", error?.message || error);
      return res.json({ ...demoBase, total: localMatches.length, jobs: localMatches });
    }
  };



  // 2. (supprimé) Estimation des transports par IA : remplacée côté interface par la localisation réelle
  //    de l'offre (carte OpenStreetMap + itinéraire), sans donnée inventée.

  // 3. CV LaTeX adapté
  app.post("/api/tailor/latex", async (req, res) => {
    const { candidate, job } = req.body || {};
    const template = normalizeTemplate(req.body?.template ?? candidate?.preferredTemplate);

    if (!hasItems(candidate?.experiences)) {
      return res.status(400).json({
        error: "PROFIL_INCOMPLET",
        message: "Renseignez au moins une expérience dans votre profil avant de générer un CV."
      });
    }

    const match = calculateCandidateMatch(candidate?.skills || [], job?.skillsRequired || []);
    const ai = getGeminiClient();
    const gen = ai ? makeGenerate(ai) : null;

    // 1. Analyse de l'offre → 2. contenu adapté + garde-fous → 3. mise en forme par le modèle (jamais par l'IA)
    const analysis = await cachedOfferAnalysis(gen?.generate || null, job);
    const result = await tailorCv(gen?.generate || null, candidate, job, analysis);
    const latexCode = generateFallbackLatex(applyTailored(candidate, result.tailored), job, template, { tailored: true });

    const notices: string[] = [];
    if (!ai) notices.push("Service IA indisponible : CV construit à partir de votre profil, sans reformulation.");
    else if (result.source !== "ai") notices.push(`Adaptation IA impossible (${result.error || "erreur"}) : CV construit à partir de votre profil.`);
    if (result.rejected.length) {
      notices.push(`${result.rejected.length} proposition(s) de l'IA écartée(s) car absentes de votre profil (${result.rejected.slice(0, 2).map((r) => r.reason).join(" ; ")}) : le texte d'origine est conservé.`);
    }
    if (gen?.used.length && !gen.used.includes(MODEL_BEST) && result.source === "ai") {
      notices.push(`Rédigé avec ${gen.used[gen.used.length - 1]} (le modèle ${MODEL_BEST} n'est pas accessible avec cette clé : activez la facturation du projet Google Cloud pour l'utiliser).`);
    }
    logEvent("info", "cv_tailored", { source: result.source, models: gen?.used || [], rejected: result.rejected.length, analysis: analysis.source });

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

  // 3 ter. Retouche ciblée d'une puce, de l'accroche ou du titre
  app.post("/api/tailor/rewrite", async (req, res) => {
    const { candidate, job, text, instruction } = req.body || {};
    const kind = ["bullet", "summary", "headline"].includes(req.body?.kind) ? req.body.kind : "bullet";
    if (!String(text || "").trim()) return res.status(400).json({ success: false, error: "Texte à retoucher manquant." });
    const ai = getGeminiClient();
    if (!ai) return res.status(503).json({ success: false, error: "Service IA indisponible : modifiez le texte à la main." });
    try {
      const { generate, used } = makeGenerate(ai);
      const out = await rewriteText(generate, candidate, job, String(text), String(instruction || ""), kind);
      return res.json({
        success: true,
        text: out.text,
        model: used[used.length - 1],
        rejected: out.rejected ? `Proposition écartée : ${out.rejected}. Le texte d'origine est conservé.` : undefined
      });
    } catch (e: any) {
      return res.status(502).json({ success: false, error: isRateLimitOrQuotaError(e) ? "Quota IA atteint : réessayez plus tard." : "Le service IA n'a pas répondu. Réessayez." });
    }
  });

  // 4. Lettre de motivation
  app.post("/api/tailor/letter", async (req, res) => {
    const { candidate, job } = req.body || {};
    const fallback = (reason: string) => res.json({ source: "standard-template", notice: reason, letter: generateFallbackLetter(candidate, job) });

    const ai = getGeminiClient();
    if (!ai) return fallback("Service IA indisponible : lettre modèle à personnaliser.");

    try {
      const { generate } = makeGenerate(ai);
      // Même analyse que le CV (en cache) : lettre et CV mettent en avant les mêmes points
      const analysis = req.body?.analysis && typeof req.body.analysis === "object" ? req.body.analysis : await cachedOfferAnalysis(generate, job);
      const prompt = `Rédige une lettre de motivation en français, sur mesure, pour :

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

      const response = await callGeminiResilient(ai, { preferredModel: MODEL_BEST, contents: prompt });
      const letter = (response.text || "").replace(/^```[a-z]*\n?|```$/g, "").trim();
      if (letter.length > 100) {
        return res.json({ source: "gemini-ai", letter });
      }
      return fallback("Réponse IA vide : lettre modèle à personnaliser.");
    } catch (e: any) {
      return fallback(isRateLimitOrQuotaError(e) ? "Quota IA atteint : lettre modèle à personnaliser." : "Service IA en erreur : lettre modèle à personnaliser.");
    }
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

  // 4 ter. Compilation PDF locale (si pdflatex ou tectonic est installé sur la machine du serveur)
  app.get("/api/latex/templates", (req, res) => res.json({ templates: TEMPLATES }));
  app.get("/api/latex/compiler", async (req, res) => {
    const c = await detectLatexCompiler();
    res.json({ available: !!c, compiler: c?.kind || null });
  });
  app.post("/api/latex/compile", async (req, res) => {
    const tex = String(req.body?.latexCode || "");
    const result = await compileLatex(tex);
    if (result.error === "NO_COMPILER") {
      return res.status(501).json({ success: false, error: "Aucun compilateur LaTeX sur le serveur (installez TeX Live, MiKTeX ou tectonic), ou utilisez Overleaf." });
    }
    if (!result.pdf) {
      return res.status(422).json({ success: false, error: result.error || "Compilation impossible.", log: result.log });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="cv.pdf"');
    return res.send(result.pdf);
  });

  // 5. Kit de préparation d'entretien
  app.post("/api/interview/prep-kit", async (req, res) => {
    const { candidate, job } = req.body || {};
    const fallback = () => res.json({ source: "standard-coaching-model", ...generateFallbackPrepKit(candidate, job) });

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
  app.post("/api/interview/evaluate-answer", async (req, res) => {
    const { question, answer, jobTitle, company, candidate } = req.body || {};
    const unavailable = (verdict: string) => res.json({
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
    if (!ai) return unavailable("Évaluation IA indisponible (service hors ligne).");

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
      return unavailable("Impossible d'extraire l'évaluation IA. Réessayez.");
    } catch {
      return unavailable("Service d'évaluation IA indisponible.");
    }
  });

  // Erreurs non gérées sur /api
  app.use("/api", (err: any, req: any, res: any, next: any) => {
    logEvent("error", "api_unhandled", { path: req.path, message: String(err?.message || err) });
    if (res.headersSent) return next(err);
    const status = err.type === "entity.too.large" ? 413 : (err.status || 500);
    return res.status(status).json({
      success: false,
      error: status === 413 ? "Fichier trop volumineux (8 Mo maximum)." : (err.message || "Une erreur est survenue.")
    });
  });

  // Production : NODE_ENV=production, ou serveur lancé depuis le bundle (npm start → dist/server.cjs)
  const isProduction = process.env.NODE_ENV === "production" || /server\.cjs$/.test(process.argv[1] || "");
  if (!isProduction) {
    // Import dynamique : Vite n'est chargé qu'en développement
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    logEvent("info", "server_started", { port: PORT, mode: isProduction ? "production" : "development", storage: kv().kind, sources: getSourceStatus() });
  });
}

startServer();
