/**
 * Vérifie la clé Gemini et la chaîne de génération du CV avec un profil et une offre d'exemple.
 *   npm run check:ai
 * Indique quels modèles sont accessibles (le modèle Pro exige un projet Google Cloud avec facturation).
 */
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { analyzeOffer, tailorCv, type GenerateFn } from "../server/cvPipeline.ts";

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.log("GEMINI_API_KEY absente du .env : l'application utilise les modèles de CV sans IA.");
  process.exit(0);
}
const ai = new GoogleGenAI({ apiKey: key });
const BEST = process.env.GEMINI_MODEL_BEST || "gemini-3.1-pro-preview";
const FAST = process.env.GEMINI_MODEL_FAST || "gemini-3.8-flash";

console.log("\nModèles :");
for (const model of [BEST, FAST]) {
  const t = Date.now();
  try {
    const r = await ai.models.generateContent({ model, contents: "Réponds uniquement : OK" });
    console.log(`  ✓ ${model.padEnd(28)} ${(r.text || "").trim().slice(0, 20)} (${Date.now() - t} ms)`);
  } catch (e: any) {
    console.log(`  ✗ ${model.padEnd(28)} ${String(e?.message || e).replace(/\s+/g, " ").slice(0, 160)}`);
  }
}

const generate: GenerateFn = async (prompt, { quality, json }) => {
  const chain = [...(quality === "best" ? [BEST] : []), FAST, "gemini-3.6-flash", "gemini-3.5-flash"];
  for (const model of chain) {
    try {
      const r = await ai.models.generateContent({ model, contents: prompt, config: json ? { responseMimeType: "application/json" } : undefined });
      console.log(`    (réponse de ${model})`);
      return r.text || "";
    } catch (e: any) {
      if (model === chain[chain.length - 1]) throw e;
    }
  }
  return "";
};

const candidate = {
  fullName: "Exemple Candidat", title: "Chef de projet informatique",
  summary: "Alternant chef de projet informatique, déploiement d'outils numériques et accompagnement des utilisateurs.",
  skills: ["Gestion de projet", "Jira", "Python", "Kubernetes", "Conduite du changement"],
  experiences: [
    { id: "e1", title: "Chef de projet informatique (alternance)", company: "Organisme de formation", startDate: "2025", endDate: "Présent",
      bullets: ["Déploiement de logiciels internes", "Production de tutoriels vidéo e-learning", "Recueil des besoins utilisateurs"] },
    { id: "e2", title: "Stagiaire SRE", company: "Éditeur logiciel", startDate: "2023", endDate: "2023",
      bullets: ["Automatisation du monitoring en Python", "Déploiements Kubernetes avec Helm"] }
  ]
};
const job = {
  title: "Chef de projet SI en alternance (H/F)", company: "Collectivité",
  description: "Au sein de la DSI, vous pilotez des projets de déploiement d'applications métiers : recueil des besoins, rédaction des cahiers des charges, recette, conduite du changement et formation des utilisateurs. Outils : Jira, Confluence.",
  skillsRequired: ["Gestion de projet", "Jira", "Confluence", "Conduite du changement"]
};

console.log("\n1. Analyse de l'offre");
const analysis = await analyzeOffer(generate, job);
console.log(JSON.stringify(analysis, null, 2));
console.log("\n2. Contenu adapté (après garde-fous)");
const r = await tailorCv(generate, candidate, job, analysis);
console.log(JSON.stringify(r.tailored, null, 2));
if (r.rejected.length) console.log("Écarté :", r.rejected);
if (r.error) console.log("Erreur :", r.error);
