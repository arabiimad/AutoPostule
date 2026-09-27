/**
 * Vers quoi pointe le bouton « Postuler » d'une offre : canal de candidature (résolu par
 * automation/channels.ts) et famille de la page (logiciel de recrutement, plateforme, site d'emploi).
 * Sert à mesurer où concentrer l'effort (quel connecteur construire ensuite) et à filtrer l'agent.
 */
import { resolveApplyChannel } from "../automation/channels.ts";

/** Familles reconnues par nom d'hôte ; `auto` = candidature automatique déjà prise en charge par Kareer. */
export const HOST_FAMILIES: { family: string; label: string; kind: "ats" | "platform" | "public" | "interim"; re: RegExp }[] = [
  // Logiciels de recrutement (pages carrière des employeurs)
  { family: "lever", label: "Lever", kind: "ats", re: /(^|\.)lever\.co$/ },
  { family: "greenhouse", label: "Greenhouse", kind: "ats", re: /(^|\.)greenhouse\.io$/ },
  { family: "workday", label: "Workday", kind: "ats", re: /(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$/ },
  { family: "smartrecruiters", label: "SmartRecruiters", kind: "ats", re: /(^|\.)smartrecruiters\.com$/ },
  { family: "teamtailor", label: "Teamtailor", kind: "ats", re: /(^|\.)teamtailor\.com$/ },
  { family: "recruitee", label: "Recruitee", kind: "ats", re: /(^|\.)recruitee\.com$/ },
  { family: "welcomekit", label: "Welcome Kit", kind: "ats", re: /(^|\.)welcomekit\.co$/ },
  { family: "taleez", label: "Taleez", kind: "ats", re: /(^|\.)taleez\.com$/ },
  { family: "flatchr", label: "Flatchr", kind: "ats", re: /(^|\.)flatchr\.io$/ },
  { family: "digitalrecruiters", label: "DigitalRecruiters", kind: "ats", re: /(^|\.)digitalrecruiters\.com$/ },
  { family: "talentsoft", label: "Talentsoft / Cegid", kind: "ats", re: /(^|\.)talent-soft\.com$|(^|\.)cegid\.cloud$/ },
  { family: "successfactors", label: "SAP SuccessFactors", kind: "ats", re: /(^|\.)successfactors\.(com|eu)$|(^|\.)jobs\.sap\.com$/ },
  { family: "taleo", label: "Oracle Taleo", kind: "ats", re: /(^|\.)taleo\.net$/ },
  { family: "oraclecloud", label: "Oracle Recruiting", kind: "ats", re: /(^|\.)oraclecloud\.com$/ },
  { family: "icims", label: "iCIMS", kind: "ats", re: /(^|\.)icims\.com$/ },
  { family: "jobvite", label: "Jobvite", kind: "ats", re: /(^|\.)jobvite\.com$/ },
  { family: "workable", label: "Workable", kind: "ats", re: /(^|\.)workable\.com$/ },
  { family: "ashby", label: "Ashby", kind: "ats", re: /(^|\.)ashbyhq\.com$/ },
  { family: "personio", label: "Personio", kind: "ats", re: /(^|\.)personio\.(de|com|fr)$/ },
  { family: "bamboohr", label: "BambooHR", kind: "ats", re: /(^|\.)bamboohr\.com$/ },
  { family: "softy", label: "Softy", kind: "ats", re: /(^|\.)softy\.pro$/ },
  { family: "beetween", label: "Beetween", kind: "ats", re: /(^|\.)beetween\.com$/ },
  { family: "jobaffinity", label: "Jobaffinity", kind: "ats", re: /(^|\.)jobaffinity\.fr$/ },
  { family: "werecruit", label: "Werecruit", kind: "ats", re: /(^|\.)werecruit\.io$/ },
  { family: "inrecruiting", label: "In Recruiting", kind: "ats", re: /(^|\.)inrecruiting\.com$/ },
  { family: "kioskemploi", label: "Kiosque emploi", kind: "ats", re: /(^|\.)kioskemploi\.com$/ },
  // Plateformes et sites d'emploi (conditions d'utilisation : pas d'envoi automatique)
  { family: "linkedin", label: "LinkedIn", kind: "platform", re: /(^|\.)linkedin\.com$/ },
  { family: "indeed", label: "Indeed", kind: "platform", re: /(^|\.)indeed\.(com|fr)$/ },
  { family: "wttj", label: "Welcome to the Jungle", kind: "platform", re: /(^|\.)welcometothejungle\.com$/ },
  { family: "hellowork", label: "HelloWork", kind: "platform", re: /(^|\.)hellowork\.com$/ },
  { family: "apec", label: "APEC", kind: "platform", re: /(^|\.)apec\.fr$/ },
  { family: "monster", label: "Monster", kind: "platform", re: /(^|\.)monster\.fr$/ },
  { family: "meteojob", label: "Meteojob", kind: "platform", re: /(^|\.)meteojob\.com$/ },
  { family: "cadremploi", label: "Cadremploi", kind: "platform", re: /(^|\.)cadremploi\.fr$/ },
  { family: "jobteaser", label: "JobTeaser", kind: "platform", re: /(^|\.)jobteaser\.com$/ },
  { family: "glassdoor", label: "Glassdoor", kind: "platform", re: /(^|\.)glassdoor\.(com|fr)$/ },
  { family: "leboncoin", label: "Leboncoin", kind: "platform", re: /(^|\.)leboncoin\.fr$/ },
  { family: "jobijoba", label: "Jobijoba", kind: "platform", re: /(^|\.)jobijoba\.com$/ },
  { family: "optioncarriere", label: "Optioncarrière", kind: "platform", re: /(^|\.)optioncarriere\.com$/ },
  { family: "staffme", label: "StaffMe", kind: "platform", re: /(^|\.)staffme\.fr$/ },
  { family: "studentjob", label: "StudentJob", kind: "platform", re: /(^|\.)studentjob\.fr$/ },
  { family: "jooble", label: "Jooble", kind: "platform", re: /(^|\.)jooble\.org$/ },
  { family: "adzuna", label: "Adzuna", kind: "platform", re: /(^|\.)adzuna\.fr$/ },
  // Services publics de l'emploi
  { family: "francetravail", label: "France Travail", kind: "public", re: /(^|\.)francetravail\.fr$|(^|\.)pole-emploi\.fr$/ },
  { family: "labonnealternance", label: "La bonne alternance", kind: "public", re: /(^|\.)apprentissage\.beta\.gouv\.fr$/ },
  { family: "fonctionpublique", label: "Choisir le service public", kind: "public", re: /(^|\.)choisirleservicepublic\.gouv\.fr$|(^|\.)place-emploi-public\.gouv\.fr$/ },
  // Agences d'intérim (sites carrière avec compte candidat)
  { family: "adecco", label: "Adecco", kind: "interim", re: /(^|\.)adecco\.fr$/ },
  { family: "randstad", label: "Randstad", kind: "interim", re: /(^|\.)randstad\.fr$/ },
  { family: "manpower", label: "Manpower", kind: "interim", re: /(^|\.)manpower\.fr$/ },
  { family: "proman", label: "Proman", kind: "interim", re: /(^|\.)proman-emploi\.fr$/ },
  { family: "synergie", label: "Synergie", kind: "interim", re: /(^|\.)synergie\.fr$/ },
  { family: "crit", label: "CRIT", kind: "interim", re: /(^|\.)crit-job\.com$/ },
  { family: "startpeople", label: "Start People", kind: "interim", re: /(^|\.)startpeople\.fr$/ },
  { family: "partnaire", label: "Partnaire", kind: "interim", re: /(^|\.)partnaire\.fr$/ }
];

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Famille de la page de candidature (« workday », « indeed »…), ou « autre:<domaine> » pour un site inconnu. */
export function applyHostFamily(url: string): string {
  if (/^mailto:/i.test(url)) return "email";
  const host = hostOf(url);
  if (!host) return "aucun";
  const f = HOST_FAMILIES.find((h) => h.re.test(host));
  return f ? f.family : `autre:${host.split(".").slice(-2).join(".")}`;
}

export function familyInfo(family: string) {
  return HOST_FAMILIES.find((h) => h.family === family);
}

/** Canaux que Kareer sait déjà utiliser seul (sans l'utilisateur). */
export const AUTOMATED_KINDS = new Set(["email", "lever", "greenhouse", "lba"]);

/** Canal et famille d'une offre (mêmes règles que l'agent). */
export function classifyApply(offer: any): { kind: string; host: string } {
  const ch = resolveApplyChannel(offer);
  const url = ch.kind === "email" || ch.kind === "lba" ? offer?.applyUrl || ch.target : ch.target || offer?.applyUrl || "";
  return { kind: ch.kind, host: ch.kind === "email" ? "email" : applyHostFamily(String(url || "")) };
}
