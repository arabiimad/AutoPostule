/**
 * Qualification d'une offre selon la politique d'automatisation du candidat.
 * Les critères bloquants sont appliqués AVANT tout classement et toute génération (aucun coût IA inutile).
 */
import { calculateCandidateMatch, isFarFromProfile } from "../../src/utils/skillMatcher.ts";

export interface AutomationPolicy {
  userId: string;
  enabled: boolean;
  paused: boolean;
  roles: string[];
  contracts: string[];
  locations: string[];
  remote: string[];
  minSalary: number | null;
  minFit: number;
  excludedCompanies: string[];
  excludedKeywords: string[];
  channels: string[];
  dailyLimit: number;
  followUps: boolean;
}

export interface Qualification {
  ok: boolean;
  /** Motif lisible si l'offre est écartée. */
  reason?: string;
  score: number | null;
}

const norm = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const words = (s: string) => norm(s).split(/[^a-z0-9+#.]+/).filter((w) => w.length > 2 && !STOP.has(w));
const STOP = new Set(["h/f", "f/h", "les", "des", "une", "pour", "avec", "sur", "dans", "and", "the"]);

/** Salaire annuel minimal lisible dans le libellé de l'offre (« 36 000 à 42 000 € », « 38k€ ») ; null si inconnu. */
export function annualSalaryFloor(label: unknown): number | null {
  const t = norm(label).replace(/ | /g, " ");
  const m = t.match(/(\d{1,3}(?:[ .]\d{3})+|\d+(?:[.,]\d+)?)\s*(k)?/);
  if (!m) return null;
  let n = Number(m[1].replace(/[ .]/g, "").replace(",", "."));
  if (m[2]) n *= 1000;
  if (/mois|mensuel/.test(t)) n *= 12;
  if (/heure|horaire/.test(t)) n *= 1607;
  return n >= 5000 ? Math.round(n) : null;
}

export function qualifyOffer(policy: AutomationPolicy, profile: any, offer: any, now = new Date()): Qualification {
  const title = norm(offer?.title);
  const text = `${title} ${norm(offer?.company)} ${norm(offer?.description)}`;
  const score = calculateCandidateMatch(profile?.skills || [], offer?.skillsRequired || []).score;
  const no = (reason: string): Qualification => ({ ok: false, reason, score });

  if (offer?.isSpontaneous) return no("Entreprise sans offre publiée (candidature spontanée : validation manuelle).");
  if (offer?.expiresAt && new Date(offer.expiresAt).getTime() < now.getTime()) return no("Offre expirée.");
  if (policy.excludedCompanies.some((c) => c && norm(offer?.company).includes(norm(c)))) return no("Entreprise exclue.");
  const kw = policy.excludedKeywords.find((k) => k && text.includes(norm(k)));
  if (kw) return no(`Mot exclu : « ${kw} ».`);
  if (policy.contracts.length && !policy.contracts.includes(offer?.contractType)) {
    return no(offer?.contractType && offer.contractType !== "non-precise" ? `Contrat « ${offer.contractType} » hors de vos critères.` : "Type de contrat non précisé.");
  }
  if (policy.remote.length && !policy.remote.includes(offer?.remote)) return no("Télétravail hors de vos critères.");
  if (policy.locations.length && offer?.remote !== "total") {
    const loc = norm(offer?.location);
    if (!policy.locations.some((l) => l && loc.includes(norm(l)))) return no("Lieu hors de vos critères.");
  }
  if (policy.minSalary) {
    const floor = annualSalaryFloor(offer?.salary);
    if (floor !== null && floor < policy.minSalary) return no("Salaire inférieur à votre minimum.");
  }
  if (policy.roles.length) {
    const t = new Set(words(offer?.title || ""));
    const fits = policy.roles.some((r) => {
      const w = words(r);
      return w.length > 0 && w.every((x) => t.has(x) || [...t].some((y) => y.startsWith(x) || x.startsWith(y)));
    });
    if (!fits) return no("Intitulé sans rapport avec les métiers recherchés.");
  }
  if (isFarFromProfile(profile, offer)) return no("Poste éloigné de votre parcours.");
  if (score === null) return no("Compétences de l'offre non détectées : adéquation non évaluable.");
  if (score < policy.minFit) return no(`Adéquation ${score} % inférieure à votre seuil de ${policy.minFit} %.`);
  return { ok: true, score };
}

/** Politique lue depuis la base (colonnes snake_case). */
export function policyFromRow(r: any): AutomationPolicy {
  const arr = (v: any) => (Array.isArray(v) ? v.map(String) : []);
  return {
    userId: String(r.user_id),
    enabled: !!r.enabled,
    paused: !!r.paused,
    roles: arr(r.roles),
    contracts: arr(r.contracts),
    locations: arr(r.locations),
    remote: arr(r.remote),
    minSalary: r.min_salary == null ? null : Number(r.min_salary),
    minFit: Number(r.min_fit ?? 60),
    excludedCompanies: arr(r.excluded_companies),
    excludedKeywords: arr(r.excluded_keywords),
    channels: arr(r.channels),
    dailyLimit: Number(r.daily_limit ?? 5),
    followUps: !!r.follow_ups
  };
}
