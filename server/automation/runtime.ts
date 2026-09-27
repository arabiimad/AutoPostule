/**
 * Services réels du worker : recherche multi-sources, documents (même chaîne que l'interface),
 * PDF (rendu Web Chromium), messagerie (Gmail, Outlook).
 */
import { searchRealJobs } from "../jobSources.ts";
import { discoverBeyondJobBoards, learnBoards } from "../discovery/discover.ts";
import { groundedWebSearch, resolveGroundingUrl, webDiscoveryEnabled } from "../discovery/gemini.ts";
import { activeRegion, isInRegion } from "../discovery/regions.ts";
import { prepareCv, writeLetter, autonomousReadiness } from "../services/documents.ts";
import { applyTailored } from "../cvPipeline.ts";
import { renderCvHtml, generatePdfFromHtml } from "../pdf.ts";
import { normalizeTemplate } from "../latex.ts";
import { sendMail, refreshAccessToken } from "./email.ts";
import { fetchReplies } from "./replies.ts";
import type { WorkerDeps } from "./worker.ts";
import type { AutomationStore } from "./store.ts";
import type { AutomationPolicy } from "./policy.ts";
import { submitApplicationForm } from "./forms.ts";
import { applyViaLba, lbaConfigured } from "./lba.ts";
import type { Browser } from "playwright";

/**
 * Offres pour la recherche planifiée : sites d'emploi et agrégateurs, puis pages carrière des entreprises
 * et publications « on recrute » (discovery/). France uniquement dans cette version.
 */
export async function searchForPolicy(policy: AutomationPolicy, profile?: any): Promise<any[]> {
  // Sans métier dans les réglages : titre et postes visés du profil
  const roles = (policy.roles.length ? policy.roles : [...(profile?.targetRoles || []), profile?.title].filter(Boolean).map(String)).slice(0, 3);
  const locations = policy.locations.length ? policy.locations.slice(0, 2) : [""];
  const contract = policy.contracts.length === 1 ? policy.contracts[0] : "tous";
  const byId = new Map<string, any>();
  for (const query of roles) {
    for (const location of locations) {
      const r = await searchRealJobs({ query, location, contractType: contract, includeSpontaneous: false, page: 1 });
      for (const j of r.jobs) if (!byId.has(j.id)) byId.set(j.id, j);
    }
  }
  // Pages carrière rencontrées dans les liens des offres : relues aux prochaines recherches
  await learnBoards([...byId.values()].flatMap((j) => [j.applyUrl, ...(j.applyOptions || []).map((o: any) => o?.url), ...(j.alsoOn || []).map((o: any) => o?.url)]));
  const beyond = await discoverBeyondJobBoards(
    { roles, locations: policy.locations, contract },
    webDiscoveryEnabled() ? { webSearch: groundedWebSearch, resolveUrl: resolveGroundingUrl } : {}
  );
  for (const j of beyond.jobs) if (!byId.has(j.id)) byId.set(j.id, j);
  const region = activeRegion();
  return [...byId.values()].filter((j) => isInRegion(j, region));
}

// Navigateur dédié aux formulaires (contexte neuf et isolé pour chaque candidature)
let formBrowser: Promise<Browser> | null = null;
async function browser(): Promise<Browser> {
  formBrowser ||= import("playwright").then(({ chromium }) =>
    chromium.launch({ headless: true, executablePath: process.env.PW_CHROMIUM_PATH || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] }));
  const b = await formBrowser;
  if (!b.isConnected()) { formBrowser = null; return browser(); }
  return b;
}
export async function closeFormBrowser() {
  const b = formBrowser;
  formBrowser = null;
  if (b) await (await b).close().catch(() => {});
}
const FORM_HOSTS = /^(jobs(\.eu)?\.lever\.co|(boards|job-boards)(\.eu)?\.greenhouse\.io)$/;

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
    searchOffers: (policy, profile) => searchForPolicy(policy, profile),
    fetchReplies: (provider, token, destination, since) => fetchReplies(provider, token, destination, since),
    ...(lbaConfigured() ? { applyLba: (input) => applyViaLba(input) } : {}),
    async submitForm(channel, input, beforeSubmit) {
      const ctx = await (await browser()).newContext({ locale: "fr-FR", acceptDownloads: false });
      try {
        const page = await ctx.newPage();
        page.setDefaultTimeout(30_000);
        await page.goto(channel.target, { waitUntil: "load" });
        // Redirection hors du logiciel de recrutement (offre fermée, site carrières) : pas d'envoi automatique
        if (!FORM_HOSTS.test(new URL(page.url()).hostname)) {
          return { status: "needs_user", reason: "Le formulaire redirige vers un autre site : terminez la candidature vous-même." };
        }
        return await submitApplicationForm(page, channel.kind, input, { beforeSubmit });
      } finally {
        await ctx.close().catch(() => {});
      }
    }
  };
}
