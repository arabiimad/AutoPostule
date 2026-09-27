/**
 * Services réels du worker : recherche multi-sources, documents (même chaîne que l'interface),
 * PDF (rendu Web Chromium), messagerie (Gmail, Outlook).
 */
import { searchRealJobs } from "../jobSources.ts";
import { prepareCv, writeLetter, autonomousReadiness } from "../services/documents.ts";
import { applyTailored } from "../cvPipeline.ts";
import { renderCvHtml, generatePdfFromHtml } from "../pdf.ts";
import { normalizeTemplate } from "../latex.ts";
import { sendMail, refreshAccessToken } from "./email.ts";
import type { WorkerDeps } from "./worker.ts";
import type { AutomationStore } from "./store.ts";
import type { AutomationPolicy } from "./policy.ts";

export async function searchForPolicy(policy: AutomationPolicy): Promise<any[]> {
  const roles = policy.roles.slice(0, 3);
  const locations = policy.locations.length ? policy.locations.slice(0, 2) : [""];
  const contract = policy.contracts.length === 1 ? policy.contracts[0] : "tous";
  const byId = new Map<string, any>();
  for (const query of roles) {
    for (const location of locations) {
      const r = await searchRealJobs({ query, location, contractType: contract, includeSpontaneous: false, page: 1 });
      for (const j of r.jobs) if (!byId.has(j.id)) byId.set(j.id, j);
    }
  }
  return [...byId.values()];
}

export function realDeps(store: AutomationStore, workerId: string): WorkerDeps {
  return {
    store,
    workerId,
    async prepare(profile, offer) {
      // Automatisation : modèle standard (compte gratuit) ; le forfait Premium sera pris en compte avec la facturation
      const cv = await prepareCv(profile, offer, { premium: false });
      const letter = await writeLetter(profile, offer, { premium: false, analysis: cv.analysis });
      return { cv, letter, ready: autonomousReadiness(cv, letter, profile, offer) };
    },
    async renderCvPdf(profile, cv, offer) {
      const html = renderCvHtml(applyTailored(profile, cv.tailored), offer, normalizeTemplate(profile?.preferredTemplate), cv.analysis?.domain, undefined, { tailored: true });
      return generatePdfFromHtml(html);
    },
    sendMail: (provider, token, mail) => sendMail(provider, token, mail),
    refreshAccessToken: (provider, rt) => refreshAccessToken(provider, rt),
    searchOffers: (policy) => searchForPolicy(policy)
  };
}
