import { COMPREHENSIVE_REAL_JOBS } from "../src/realJobsData.ts";
import { filterJobs } from "../src/utils/jobFilter.ts";

// Base d'offres de DÉMONSTRATION : utilisée seulement si aucune source réelle n'est configurée.
export const DEMO_OFFERS = COMPREHENSIVE_REAL_JOBS.map((j) => ({ ...j, origin: "demo" as const }));

/** Âge (en jours) des libellés de la base de démo : « Hier », « Il y a 3 jours »… */
export function demoAgeInDays(label: string): number {
  if (/hier/i.test(label)) return 1;
  const m = label.match(/(\d+)\s*jour/i);
  return m ? Number(m[1]) : 0;
}

export function searchLocalJobs(query?: string, contractType?: string, location?: string) {
  const now = Date.now();
  // Dates recalculées à chaque requête : la démo ne « vieillit » pas
  return filterJobs(DEMO_OFFERS, { query, contractType, location }).map((j) => ({
    ...j,
    publishedAt: new Date(now - demoAgeInDays(String(j.publishedAt || "")) * 86_400_000).toISOString(),
    lastVerifiedAt: undefined
  }));
}

export function stableJobId(company: any, title: any, location: any): string {
  const key = [company, title, location].map((v) => String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim()).join("|");
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return `live-${h.toString(36)}`;
}
