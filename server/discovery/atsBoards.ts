/**
 * Pages carrière publiques des logiciels de recrutement (offres en JSON ouvert, publiées pour être diffusées) :
 *   Greenhouse     https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 *   Lever          https://api.lever.co/v0/postings/{company}?mode=json
 *   Ashby          https://api.ashbyhq.com/posting-api/job-board/{name}
 *   SmartRecruiters https://api.smartrecruiters.com/v1/companies/{id}/postings
 * Formats vérifiés sur de vraies entreprises (septembre 2026).
 *
 * Les entreprises à suivre ne sont pas codées en dur : chaque lien vers l'une de ces pages rencontré
 * dans une recherche (Google Jobs, recherche web, publication) enregistre la page carrière,
 * qui est ensuite relue régulièrement. ATS_BOARDS permet d'en ajouter à la main.
 */
import type { JobOffer } from "../../src/types.ts";
import { deriveSkills, inferContract, inferRemote, stripHtml } from "../jobSources.ts";

export type Ats = "greenhouse" | "lever" | "ashby" | "smartrecruiters";

export interface Board {
  ats: Ats;
  token: string;
  /** Lever : hébergement européen (api.eu.lever.co). */
  region?: "eu";
}

export const ATS_LABELS: Record<Ats, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  smartrecruiters: "SmartRecruiters"
};

export function boardId(b: Board) {
  return `${b.ats}:${b.region ? `${b.region}:` : ""}${b.token.toLowerCase()}`;
}

/** Reconnaît la page carrière d'une entreprise à partir d'un lien d'offre. */
export function detectBoard(url: string): Board | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const first = u.pathname.split("/").filter(Boolean)[0] || "";
  const token = decodeURIComponent(first).trim();
  const valid = /^[A-Za-z0-9._-]{2,80}$/.test(token);
  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
    // boards.greenhouse.io/embed/job_board?for=token
    if (token === "embed") {
      const f = u.searchParams.get("for");
      return f && /^[A-Za-z0-9._-]{2,80}$/.test(f) ? { ats: "greenhouse", token: f } : null;
    }
    return valid ? { ats: "greenhouse", token } : null;
  }
  if (host === "jobs.lever.co" && valid) return { ats: "lever", token };
  if (host === "jobs.eu.lever.co" && valid) return { ats: "lever", token, region: "eu" };
  if (host === "jobs.ashbyhq.com" && valid) return { ats: "ashby", token };
  if ((host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") && valid) return { ats: "smartrecruiters", token };
  return null;
}

/** ATS_BOARDS="greenhouse:acme,lever:globex,ashby:initech" */
export function boardsFromEnv(value = process.env.ATS_BOARDS): Board[] {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [ats, token] = s.split(":");
      return ["greenhouse", "lever", "ashby", "smartrecruiters"].includes(ats) && token ? { ats: ats as Ats, token } : null;
    })
    .filter((b): b is Board => !!b);
}

/** « acme-corp » → « Acme Corp » (Lever et Ashby ne donnent pas le nom de l'entreprise). */
export function prettyToken(token: string) {
  return String(token || "").replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function decodeEntities(s: string) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function iso(v: unknown): string {
  if (v == null || v === "") return "";
  const d = new Date(typeof v === "number" || /^\d+$/.test(String(v)) ? Number(v) : String(v));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function offer(board: Board, o: Partial<JobOffer> & { title: string; company: string; applyUrl: string; description: string; externalId: string }): JobOffer {
  const text = `${o.title}\n${o.description}`;
  const { externalId, ...rest } = o;
  rest.title = rest.title.trim();
  return {
    id: `ats-${board.ats}-${board.token}-${externalId}`.toLowerCase(),
    location: "",
    contractType: inferContract(text, "cdi", o.title),
    remote: inferRemote(text),
    skillsRequired: deriveSkills([], o.title, o.description),
    source: `Site carrière ${o.company} (${ATS_LABELS[board.ats]})`,
    origin: "ats",
    publishedAt: "",
    status: "active",
    ...rest,
    // « Remote, Bangalore » : le lieu suffit à dire que le poste est en télétravail
    ...(/\b(remote|t[ée]l[ée]travail)\b/i.test(String(rest.location || "")) ? { remote: "total" as const } : {})
  };
}

export function normalizeBoardJobs(board: Board, data: any): JobOffer[] {
  const out: JobOffer[] = [];
  if (board.ats === "greenhouse") {
    for (const j of Array.isArray(data?.jobs) ? data.jobs : []) {
      if (!j?.title || !j?.absolute_url) continue;
      out.push(offer(board, {
        externalId: String(j.id),
        title: String(j.title),
        company: String(j.company_name || board.token),
        location: String(j.location?.name || ""),
        applyUrl: String(j.absolute_url),
        description: stripHtml(decodeEntities(j.content || "")),
        publishedAt: iso(j.first_published || j.updated_at)
      }));
    }
  } else if (board.ats === "lever") {
    for (const j of Array.isArray(data) ? data : []) {
      if (!j?.text || !j?.hostedUrl) continue;
      const description = [j.descriptionPlain, ...(Array.isArray(j.lists) ? j.lists.map((l: any) => `${l.text}\n${stripHtml(l.content)}`) : []), j.additionalPlain].filter(Boolean).join("\n\n");
      const commitment = String(j.categories?.commitment || "");
      const o = offer(board, {
        externalId: String(j.id),
        title: String(j.text),
        company: prettyToken(board.token),
        location: String(j.categories?.location || ""),
        // Page de l'offre (description + bouton Postuler)
        applyUrl: String(j.hostedUrl || j.applyUrl),
        description,
        publishedAt: iso(j.createdAt)
      });
      if (j.workplaceType === "remote") o.remote = "total";
      else if (j.workplaceType === "hybrid") o.remote = "hybride";
      else if (j.workplaceType === "onsite" || j.workplaceType === "on-site") o.remote = "sur-site";
      if (commitment) o.contractType = inferContract(`${commitment} ${o.title}`, o.contractType, o.title);
      out.push(o);
    }
  } else if (board.ats === "ashby") {
    for (const j of Array.isArray(data?.jobs) ? data.jobs : []) {
      if (!j?.title || !j?.jobUrl || j.isListed === false) continue;
      const o = offer(board, {
        externalId: String(j.id),
        title: String(j.title),
        company: prettyToken(board.token),
        location: String(j.location || ""),
        applyUrl: String(j.jobUrl || j.applyUrl),
        description: String(j.descriptionPlain || stripHtml(j.descriptionHtml || "")),
        publishedAt: iso(j.publishedAt)
      });
      if (j.isRemote || j.workplaceType === "Remote") o.remote = "total";
      else if (j.workplaceType === "Hybrid") o.remote = "hybride";
      const comp = j.compensation?.compensationTierSummary || j.compensation?.scrapeableCompensationSalarySummary;
      if (comp) o.salary = String(comp);
      out.push(o);
    }
  } else if (board.ats === "smartrecruiters") {
    for (const j of Array.isArray(data?.content) ? data.content : []) {
      if (!j?.name || !j?.id) continue;
      const company = String(j.company?.name || board.token);
      const companyId = String(j.company?.identifier || board.token);
      const o = offer(board, {
        externalId: String(j.id),
        title: String(j.name),
        company,
        location: String(j.location?.fullLocation || [j.location?.city, j.location?.country?.toUpperCase()].filter(Boolean).join(", ")),
        applyUrl: `https://jobs.smartrecruiters.com/${encodeURIComponent(companyId)}/${encodeURIComponent(String(j.id))}`,
        // La liste ne contient pas l'annonce complète : intitulé, métier et contrat seulement
        description: [j.function?.label, j.typeOfEmployment?.label, j.experienceLevel?.label].filter(Boolean).join(" · "),
        publishedAt: iso(j.releasedDate)
      });
      o.descriptionIsSnippet = true;
      if (j.location?.remote) o.remote = "total";
      else if (j.location?.hybrid) o.remote = "hybride";
      out.push(o);
    }
  }
  return out;
}

export function boardApiUrl(b: Board): string {
  const t = encodeURIComponent(b.token);
  switch (b.ats) {
    case "greenhouse": return `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`;
    case "lever": return `https://api${b.region === "eu" ? ".eu" : ""}.lever.co/v0/postings/${t}?mode=json`;
    case "ashby": return `https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=true`;
    case "smartrecruiters": return `https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=100&country=fr`;
  }
}

type FetchJson = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export class BoardNotFoundError extends Error {}

export async function fetchBoardJobs(board: Board, fetchJson: FetchJson = (url) => fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } }) as any): Promise<JobOffer[]> {
  const res = await fetchJson(boardApiUrl(board));
  if (res.status === 404) throw new BoardNotFoundError(`${ATS_LABELS[board.ats]} ${board.token} introuvable`);
  if (!res.ok) throw new Error(`${ATS_LABELS[board.ats]} ${board.token} : erreur ${res.status}`);
  return normalizeBoardJobs(board, await res.json());
}
