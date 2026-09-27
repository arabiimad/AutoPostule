/**
 * Offres « cachées » trouvées sur le web public : publications de recruteurs (« on recrute »,
 * « nous recrutons »… sur LinkedIn ou ailleurs), pages carrière, annonces non diffusées sur les sites d'emploi.
 *
 * Recherche Google via Gemini (outil googleSearch) : on ne fait que lire les résultats publics d'un
 * moteur de recherche, sans se connecter ni aspirer LinkedIn. Garde-fou contre les inventions :
 * une offre n'est gardée que si son lien fait partie des pages réellement consultées par la recherche
 * (métadonnées de « grounding ») ; toute offre dont le lien a été inventé est écartée.
 */
import { createHash } from "node:crypto";
import type { ContractType, JobOffer } from "../../src/types.ts";
import { deriveSkills, inferContract, inferRemote } from "../jobSources.ts";

export interface GroundedResult {
  text: string;
  /** Pages consultées par la recherche (liens éventuellement redirigés par Google). */
  sources: { uri: string; title?: string }[];
}

export type GroundedSearchFn = (prompt: string) => Promise<GroundedResult>;
/** Suit une redirection (lien de résultat Google → vraie page). */
export type ResolveUrlFn = (uri: string) => Promise<string>;

export interface WebQuery {
  role: string;
  location?: string;
  contract?: ContractType | "tous";
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export function buildSearchPlan(q: WebQuery): string[] {
  const where = ` ${q.location || "France"}`;
  const contract = q.contract && q.contract !== "tous" ? ` ${q.contract}` : "";
  const role = `"${q.role}"`;
  return [
    `site:linkedin.com/posts ("on recrute" OR "nous recrutons" OR "je recrute" OR "recrutement" OR "hiring") ${role}${contract}${where}`,
    `${role}${contract}${where} ("nous recrutons" OR "on recrute" OR "rejoignez-nous") -site:indeed.fr -site:francetravail.fr`,
    `(site:jobs.lever.co OR site:boards.greenhouse.io OR site:jobs.ashbyhq.com OR site:jobs.smartrecruiters.com OR site:welcometothejungle.com) ${role}${where}`
  ];
}

export function buildDiscoveryPrompt(q: WebQuery): string {
  const plan = buildSearchPlan(q);
  return `Tu cherches des opportunités d'emploi RÉELLES et ACTUELLES pour un candidat.
Poste visé : ${q.role}
Lieu : ${q.location || "France"}${q.contract && q.contract !== "tous" ? `\nContrat : ${q.contract}` : ""}

Lance ces recherches Google (et des variantes proches si utile) :
${plan.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Cherche en priorité :
- des publications de recruteurs, managers ou entreprises annonçant un recrutement (« on recrute », « nous recrutons », « je cherche un(e)… »), même si aucune annonce n'est publiée sur un site d'emploi ;
- des offres sur les pages carrière des entreprises.

Règles STRICTES :
- N'invente rien. Chaque élément doit venir d'une page que tu as réellement trouvée ; "url" est l'adresse exacte de cette page.
- Ignore les publications de plus de 60 jours, les candidats qui cherchent un emploi, les formations et les annonces sans rapport avec le poste.
- "excerpt" : la phrase de la page qui annonce le recrutement, recopiée telle quelle (200 caractères maximum).
- "contactEmail" : seulement si une adresse de candidature figure sur la page, sinon "".
- "publishedAt" : date ISO si visible, sinon "".

Renvoie UNIQUEMENT un tableau JSON :
[{"title": "...", "company": "...", "location": "...", "kind": "post" ou "job", "url": "...", "excerpt": "...", "contactEmail": "", "publishedAt": ""}]
Tableau vide [] si tu ne trouves rien de fiable.`;
}

/** Forme canonique d'un lien pour comparer (sans protocole, www, paramètres de suivi, / final). */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|trk|originalSubdomain|lipi|ref|source)/i.test(k)) u.searchParams.delete(k);
    const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^[a-z]{2}\.linkedin\.com$/, "linkedin.com");
    return `${host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return "";
  }
}

function extractArray(text: string): any[] {
  const m = String(text || "").match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function sourceLabel(url: string, kind: string): string {
  const host = (() => {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "web"; }
  })();
  if (/linkedin\.com$/.test(host)) return kind === "post" ? "Publication LinkedIn (à vérifier)" : "LinkedIn (à vérifier)";
  if (/welcometothejungle\.com$/.test(host)) return "Welcome to the Jungle (recherche web)";
  return kind === "post" ? `Publication sur ${host} (à vérifier)` : `${host} (recherche web)`;
}

export async function discoverFromWeb(
  search: GroundedSearchFn,
  q: WebQuery,
  opts: { resolveUrl?: ResolveUrlFn; now?: Date } = {}
): Promise<{ offers: JobOffer[]; urls: string[]; rejected: number }> {
  const result = await search(buildDiscoveryPrompt(q));
  const resolve = opts.resolveUrl || (async (u: string) => u);

  // Pages réellement consultées : seules sources acceptées
  const grounded = new Map<string, string>();
  const urls: string[] = [];
  await Promise.all(
    result.sources.slice(0, 40).map(async (s) => {
      try {
        const real = await resolve(s.uri);
        const c = canonicalUrl(real);
        if (c) {
          grounded.set(c, real);
          urls.push(real);
        }
      } catch {
        /* lien illisible : ignoré */
      }
    })
  );

  const now = opts.now || new Date();
  const maxAge = 60 * 86_400_000;
  let rejected = 0;
  const offers: JobOffer[] = [];
  for (const item of extractArray(result.text)) {
    const title = String(item?.title || "").trim();
    const url = String(item?.url || "").trim();
    const real = grounded.get(canonicalUrl(url));
    if (!title || !real) {
      rejected++;
      continue;
    }
    const publishedAt = /^\d{4}-\d{2}-\d{2}/.test(String(item.publishedAt || "")) ? new Date(item.publishedAt).toISOString() : "";
    if (publishedAt && now.getTime() - new Date(publishedAt).getTime() > maxAge) {
      rejected++;
      continue;
    }
    const kind = item.kind === "post" ? "post" : "job";
    const excerpt = String(item.excerpt || "").trim().slice(0, 300);
    const email = String(item.contactEmail || "").match(EMAIL_RE)?.[0] || excerpt.match(EMAIL_RE)?.[0] || "";
    const company = String(item.company || "").trim() || "Entreprise à identifier";
    const location = String(item.location || q.location || "").trim();
    const description = excerpt || `${title} — ${company}`;
    offers.push({
      id: `web-${createHash("sha1").update(canonicalUrl(real)).digest("hex").slice(0, 16)}`,
      title,
      company,
      location,
      contractType: inferContract(`${title} ${excerpt} ${q.contract || ""}`, q.contract && q.contract !== "tous" ? q.contract : "cdi", title),
      remote: inferRemote(`${title} ${excerpt}`),
      description,
      descriptionIsSnippet: true,
      skillsRequired: deriveSkills([], title, excerpt),
      source: sourceLabel(real, kind),
      origin: kind === "post" ? "web-post" : "web",
      isPost: kind === "post",
      postExcerpt: excerpt || undefined,
      applyUrl: real,
      ...(email ? { contactEmail: email } : {}),
      publishedAt,
      status: "active"
    });
  }
  return { offers, urls, rejected };
}
