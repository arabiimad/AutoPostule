import type { Express } from "express";
import { searchRealJobs, hasRealSources, getSourceStatus } from "../jobSources.ts";
import { kv, getQuotaUsage } from "../store.ts";
import { getGeminiClient, callGeminiResilient, MODEL_FAST } from "../ai.ts";
import { searchLocalJobs, stableJobId } from "../demoJobs.ts";
import { logEvent } from "../log.ts";

export function registerJobRoutes(app: Express) {
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
}
