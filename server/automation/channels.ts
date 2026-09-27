/**
 * Canal de candidature d'une offre, déterminé par le serveur (jamais par le modèle d'IA) :
 * - email : adresse publiée DANS l'offre pour recevoir les candidatures ;
 * - lever / greenhouse : formulaire hébergé par ces logiciels de recrutement ;
 * - platform : LinkedIn, Indeed, Welcome to the Jungle… dont les conditions interdisent l'envoi automatisé
 *   → validation manuelle par le candidat (dossier prêt, notification) ;
 * - unknown : site carrières non reconnu → validation manuelle.
 */

export type ApplyChannel =
  | { kind: "email"; target: string; evidence: string }
  | { kind: "lever"; target: string; site: string; postingId: string }
  | { kind: "greenhouse"; target: string; board: string; jobId: string }
  | { kind: "platform"; target: string; platform: string }
  | { kind: "unknown"; target: string };

/** Plateformes dont les conditions d'utilisation interdisent les candidatures automatisées. */
const PLATFORMS: [RegExp, string][] = [
  [/(^|\.)linkedin\.com$/i, "LinkedIn"],
  [/(^|\.)indeed\.(com|fr)$/i, "Indeed"],
  [/(^|\.)welcometothejungle\.com$/i, "Welcome to the Jungle"],
  [/(^|\.)hellowork\.com$/i, "HelloWork"],
  [/(^|\.)glassdoor\.(com|fr)$/i, "Glassdoor"],
  [/(^|\.)monster\.fr$/i, "Monster"],
  [/(^|\.)jobteaser\.com$/i, "JobTeaser"],
  [/(^|\.)francetravail\.fr$/i, "France Travail"],
  [/(^|\.)apprentissage\.beta\.gouv\.fr$/i, "La bonne alternance"],
  [/(^|\.)jooble\.org$/i, "Jooble"],
  [/(^|\.)adzuna\.fr$/i, "Adzuna"]
];

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
/** Adresses à ne jamais utiliser pour postuler. */
const NEVER_LOCAL = /^(no-?reply|ne-?pas-?repondre|donotreply|mailer-daemon|postmaster|abuse|privacy|dpo|rgpd|gdpr|support|facturation|billing|compta|webmaster|newsletter)$/i;
/** Adresses de recrutement par nature. */
const RECRUIT_LOCAL = /^(rh|drh|recrutement|recrutements|recruitment|recruiting|jobs?|careers?|carrieres?|candidatures?|emploi|talents?|hr|stages?|alternance)([._+-].*)?$/i;
/** Contexte d'une adresse donnée pour postuler (« envoyez votre CV à … »). */
const APPLY_CONTEXT = /(candidature|postuler|cv|curriculum|lettre de motivation|envoy|adress|recrutement|apply|resume)/i;

function host(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Adresse de candidature publiée dans le texte de l'offre, avec l'extrait qui le prouve. */
export function findApplicationEmail(text: string): { email: string; evidence: string } | null {
  const src = String(text || "");
  const candidates: { email: string; evidence: string; score: number }[] = [];
  for (const m of src.matchAll(EMAIL_RE)) {
    const email = m[0].replace(/[.,;:]+$/, "").toLowerCase();
    const local = email.split("@")[0];
    if (NEVER_LOCAL.test(local)) continue;
    const start = Math.max(0, (m.index || 0) - 120);
    const evidence = src.slice(start, (m.index || 0) + m[0].length + 40).replace(/\s+/g, " ").trim();
    const context = APPLY_CONTEXT.test(src.slice(start, (m.index || 0)));
    const recruit = RECRUIT_LOCAL.test(local);
    if (!context && !recruit) continue; // adresse de contact sans lien établi avec la candidature
    candidates.push({ email, evidence, score: (context ? 2 : 0) + (recruit ? 1 : 0) });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ? { email: candidates[0].email, evidence: candidates[0].evidence } : null;
}

export function parseAtsUrl(url: string): ApplyChannel | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (h === "jobs.lever.co" || h === "jobs.eu.lever.co") {
    const [site, postingId] = parts;
    if (site && postingId && /^[0-9a-f-]{36}$/i.test(postingId)) {
      return { kind: "lever", site, postingId, target: `https://${h}/${site}/${postingId}/apply` };
    }
  }
  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(h)) {
    const i = parts.indexOf("jobs");
    const board = parts[0];
    const jobId = i >= 0 ? parts[i + 1] : u.searchParams.get("gh_jid") || "";
    if (board && /^\d+$/.test(jobId || "")) return { kind: "greenhouse", board, jobId: jobId!, target: `https://${h}/${board}/jobs/${jobId}` };
  }
  return null;
}

/**
 * Canal d'une offre. Priorité : formulaire reconnu (Lever, Greenhouse) parmi les liens de candidature,
 * puis adresse de candidature publiée dans l'offre, puis plateforme (validation manuelle).
 */
export function resolveApplyChannel(offer: { applyUrl?: string; url?: string; description?: string; applyOptions?: { url?: string; apply_link?: string }[] }): ApplyChannel {
  const links = [offer.applyUrl, offer.url, ...(offer.applyOptions || []).map((o) => o?.url || o?.apply_link)]
    .filter((l): l is string => typeof l === "string" && /^(https?:\/\/|mailto:)/i.test(l));
  for (const l of links) {
    const ats = parseAtsUrl(l);
    if (ats) return ats;
  }
  for (const l of links) {
    if (/^mailto:/i.test(l)) {
      const email = l.replace(/^mailto:/i, "").split("?")[0].toLowerCase();
      if (!NEVER_LOCAL.test(email.split("@")[0])) return { kind: "email", target: email, evidence: l };
    }
  }
  const mail = findApplicationEmail(offer.description || "");
  if (mail) return { kind: "email", target: mail.email, evidence: mail.evidence };
  const first = links.find((l) => /^https?:/i.test(l)) || "";
  const platform = PLATFORMS.find(([re]) => re.test(host(first)));
  if (platform) return { kind: "platform", platform: platform[1], target: first };
  return { kind: "unknown", target: first };
}

/** Le canal permet-il un envoi automatique (selon les canaux autorisés par le candidat) ? */
export function isAutomatable(channel: ApplyChannel, allowed: string[]): boolean {
  if (channel.kind === "email") return allowed.includes("email");
  if (channel.kind === "lever" || channel.kind === "greenhouse") return allowed.includes("form");
  return false;
}
