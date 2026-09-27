/**
 * Garde-fous appliqués avant chaque envoi, quel que soit le niveau d'automatisation.
 */
import type { AutomationSettings, Submission, Task } from "./types.ts";

const DAY = 86_400_000;

const norm = (s: unknown) =>
  String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\b(sas|sasu|sa|sarl|eurl|inc|ltd|gmbh|group|groupe)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export const companyKey = norm;

/** Identifiant d'une offre, stable entre sources (entreprise + intitulé + lieu). */
export function jobKey(job: any): string {
  return [job?.company, job?.title, job?.location].map(norm).join("|");
}

export type GuardDecision =
  | { action: "proceed" }
  | { action: "cancel"; reason: string }
  | { action: "reschedule"; runAt: string; reason: string };

export function checkGuardrails(task: Task, settings: AutomationSettings, recent: Submission[], now = new Date()): GuardDecision {
  const job = task.payload.job || {};
  const company = norm(job.company);

  if (company && settings.excludedCompanies.some((c) => norm(c) && company.includes(norm(c)))) {
    return { action: "cancel", reason: `${job.company} fait partie des entreprises exclues` };
  }

  // Seuil de score : seulement pour les offres trouvées par l'agent (l'utilisateur peut forcer une candidature)
  if (task.payload.origin === "agent" && typeof job.matchScore === "number" && job.matchScore < settings.minMatchScore) {
    return { action: "cancel", reason: `score ${job.matchScore} % inférieur au minimum de ${settings.minMatchScore} %` };
  }

  const key = jobKey(job);
  if (recent.some((s) => s.jobKey === key)) {
    return { action: "cancel", reason: "candidature déjà envoyée pour cette offre" };
  }

  const cooldownStart = new Date(now.getTime() - settings.sameCompanyCooldownDays * DAY).toISOString();
  if (company && !job.isSpontaneous && recent.some((s) => s.submittedAt >= cooldownStart && norm(s.company) === company)) {
    return { action: "cancel", reason: `déjà une candidature chez ${job.company} depuis moins de ${settings.sameCompanyCooldownDays} jours` };
  }

  if (settings.paused) {
    return { action: "reschedule", runAt: new Date(now.getTime() + 6 * 3_600_000).toISOString(), reason: "agent en pause" };
  }

  // Plafond sur 24 heures glissantes : on attend que le plus ancien envoi sorte de la fenêtre
  const windowStart = new Date(now.getTime() - DAY).toISOString();
  const lastDay = recent.filter((s) => s.submittedAt >= windowStart).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  if (lastDay.length >= settings.dailyCap) {
    const oldest = lastDay[lastDay.length - settings.dailyCap];
    const runAt = new Date(new Date(oldest.submittedAt).getTime() + DAY + 60_000).toISOString();
    return { action: "reschedule", runAt, reason: `plafond de ${settings.dailyCap} envois par jour atteint` };
  }

  return { action: "proceed" };
}

/** L'envoi doit-il être validé par l'utilisateur ? */
export function needsApproval(settings: AutomationSettings): boolean {
  if (settings.level === "manual") return true;
  if (settings.level === "rules") return false;
  return settings.cleanApprovals < settings.progressiveThreshold;
}

/** Plus longue fenêtre à relire pour appliquer les garde-fous. */
export function lookbackStart(settings: AutomationSettings, now = new Date()): string {
  return new Date(now.getTime() - Math.max(settings.sameCompanyCooldownDays, 90) * DAY).toISOString();
}

export function sanitizeSettings(input: any, current: AutomationSettings): AutomationSettings {
  const int = (v: any, min: number, max: number, fallback: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const i = input || {};
  return {
    level: ["manual", "rules", "progressive"].includes(i.level) ? i.level : current.level,
    paused: typeof i.paused === "boolean" ? i.paused : current.paused,
    minMatchScore: i.minMatchScore !== undefined ? int(i.minMatchScore, 0, 100, current.minMatchScore) : current.minMatchScore,
    dailyCap: i.dailyCap !== undefined ? int(i.dailyCap, 1, 50, current.dailyCap) : current.dailyCap,
    sameCompanyCooldownDays: i.sameCompanyCooldownDays !== undefined ? int(i.sameCompanyCooldownDays, 0, 365, current.sameCompanyCooldownDays) : current.sameCompanyCooldownDays,
    excludedCompanies: Array.isArray(i.excludedCompanies)
      ? i.excludedCompanies.map((c: any) => String(c).trim()).filter(Boolean).slice(0, 200)
      : current.excludedCompanies,
    progressiveThreshold: i.progressiveThreshold !== undefined ? int(i.progressiveThreshold, 1, 100, current.progressiveThreshold) : current.progressiveThreshold,
    // Compteur géré par le serveur uniquement
    cleanApprovals: current.cleanApprovals
  };
}
