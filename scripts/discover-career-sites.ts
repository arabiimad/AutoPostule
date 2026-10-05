/**
 * Découverte des sites carrières : trouve quelles entreprises françaises publient leurs offres via un
 * logiciel de recrutement à API publique (Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee, Teamtailor).
 *
 *  1. Liste d'entreprises : API publique « Recherche d'entreprises » (grandes entreprises, ETI, PME du
 *     numérique et du conseil) + une liste de marques connues (startups, enseignes).
 *  2. Identifiants candidats déduits du nom (« BACK MARKET » → backmarket, back-market).
 *  3. Chaque identifiant est testé sur chaque ATS ; on ne garde que les sites qui ont au moins une offre
 *     en France (et, quand l'ATS donne le nom de l'entreprise, un nom qui correspond).
 *
 * Résultat : server/data/careerSites.generated.ts (lu par server/careerSitesDirectory.ts).
 * Reprise possible : les réponses déjà obtenues sont conservées dans .cache/career-sites/.
 *
 *   npm run discover:sites                 # tout
 *   npm run discover:sites -- --limit 500  # essai rapide
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AtsCompany, AtsKind } from "../server/careerSitesDirectory.ts";
import {
  normalizeGreenhouseJob, normalizeLeverJob, normalizeAshbyJob, normalizeRecruiteeJob, parseTeamtailorRss
} from "../server/careerSites.ts";

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const LIMIT = Number(arg("limit")) || Infinity;
const WORK_DIR = arg("work-dir") || ".cache/career-sites";
const OUT = arg("out") || "server/data/careerSites.generated.ts";
const CONCURRENCY = Number(arg("concurrency")) || 32;
mkdirSync(WORK_DIR, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (v: string) => (v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

async function fetchRetry(url: string, init: any = {}, tries = 4): Promise<Response | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(25_000) });
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (i + 1)); continue; }
      return res;
    } catch {
      await sleep(1500 * (i + 1));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. Entreprises
// ---------------------------------------------------------------------------
interface Company { name: string; names: string[]; acronym?: string }

const SEARCH = "https://recherche-entreprises.api.gouv.fr/search";
/** Grandes entreprises, ETI, puis PME de 20 salariés et plus dans le numérique, le conseil et la pub. */
const QUERIES: string[] = [
  "categorie_entreprise=GE",
  "categorie_entreprise=ETI",
  ...["62.01Z", "62.02A", "62.02B", "62.03Z", "62.09Z", "58.29A", "58.29C", "63.11Z", "63.12Z", "70.22Z", "73.11Z", "71.12B", "72.19Z", "64.19Z", "66.19B", "86.90F"]
    .map((naf) => `activite_principale=${naf}&tranche_effectif_salarie=12,21,22,31,32,41,42,51,52,53`)
];

/** Marques connues dont la raison sociale diffère souvent du nom d'usage. */
const SEED_BRANDS: string[] = ["Doctolib", "Qonto", "Alan", "Swile", "Payfit", "Spendesk", "Pennylane", "Agicap", "Lydia", "Sumeria", "Alma", "Ledger", "Sorare", "Back Market", "Vinted", "BlaBlaCar", "Contentsquare", "Dataiku", "Mirakl", "Algolia", "Criteo", "Deezer", "Believe", "ManoMano", "Vestiaire Collective", "Ankorstore", "Malt", "Pigment", "Aircall", "Livestorm", "Lucca", "Partoo", "Sunday", "lemlist", "Shine", "Ornikar", "Getaround", "Heetch", "Frichti", "Sezane", "Jow", "Yousign", "Skello", "Matera", "Brevo", "Botify", "Dashlane", "Scaleway", "OVHcloud", "Withings", "Photoroom", "Mistral", "Mistral AI", "Hugging Face", "GitGuardian", "Ivalua", "Younited", "Libeo", "Indy", "Dougs", "Ekwateur", "Leboncoin", "Adevinta", "Meero", "OpenClassrooms", "Welcome to the Jungle", "Side", "StaffMe", "Ubble", "Zenchef", "Tiller", "Padoa", "Epsor", "Payplug", "Swan", "Hiboo", "Exotec", "Ynsect", "Electra", "Zity", "Cityscoot", "Dott", "Lime", "Bolt", "Free Now", "Pretto", "Meilleurtaux", "Luko", "Leocare", "Wakam", "Stello", "Hosman", "Masteos", "Jellysmack", "Brigad", "Expensya", "Silvr", "Defacto", "Shift Technology", "AB Tasty", "Kameleoon", "Mention", "Sendcloud", "Cubyn", "Upply", "Owkin", "Lifen", "Voodoo", "Ubisoft", "Ankama", "Nacon", "Focus Entertainment", "Gameloft", "Dontnod", "Quantic Dream", "Amplitude Studios", "Arkane", "Asmodee", "Netatmo", "Unseenlabs", "Verkor", "Hysetco", "McPhy", "Lhyfe", "Cdiscount", "Showroomprive", "Veepee", "Fnac Darty", "Decathlon", "Leroy Merlin", "Castorama", "Boulanger", "Kiabi", "Auchan", "Carrefour", "Intermarche", "Lidl", "Sephora", "LOreal", "LVMH", "Kering", "Hermes", "Chanel", "Dior", "Louis Vuitton", "Cartier", "Lacoste", "Jacquemus", "Balzac Paris", "Le Slip Francais", "Asphalte", "Typology", "Horace", "Seazon", "Ector", "Joone", "Flink", "Quitoque", "Ulule", "Yomoni", "Nalo", "Ramify", "Goodvest", "Nickel", "Orange", "Bouygues Telecom", "Free", "SFR", "Iliad", "Capgemini", "Sopra Steria", "Atos", "Eviden", "Devoteam", "Accenture", "Wavestone", "Onepoint", "Talan", "Octo Technology", "Theodo", "Padok", "Ippon", "BAM", "Sfeir", "Zenika", "Xebia", "Publicis Sapient", "Havas", "Artefact", "Ekimetrics", "Sia Partners", "Mazars", "Forvis Mazars", "Deloitte", "KPMG", "EY", "PwC", "Grant Thornton", "BNP Paribas", "Societe Generale", "Credit Agricole", "AXA", "Allianz", "Generali", "Natixis", "BPCE", "Amundi", "Covea", "MAIF", "Macif", "Groupama", "Ayvens", "Arval", "Airbus", "Thales", "Safran", "Dassault Systemes", "Dassault Aviation", "Naval Group", "MBDA", "KNDS", "ArianeGroup", "Alstom", "Valeo", "Forvia", "Renault", "Stellantis", "Michelin", "OPmobility", "Saint-Gobain", "Schneider Electric", "Legrand", "Nexans", "Engie", "EDF", "TotalEnergies", "Veolia", "Suez", "Vinci", "Eiffage", "Colas", "Spie", "Equans", "Sodexo", "Elior", "Accor", "Pernod Ricard", "Danone", "Lactalis", "Bonduelle", "Sanofi", "Servier", "Ipsen", "Pierre Fabre", "bioMerieux", "Cegid", "Sage", "Talentsoft", "Datadog", "Stripe", "Airbnb", "Spotify", "Deliveroo", "Uber", "Doctrine", "Hivebrite", "Ogury", "Teads", "Dailymotion", "Blade", "Shadow", "Lunchr", "Payfit", "Yespark", "Zenly", "Wizbii", "JobTeaser", "Studyrama", "Pass Culture", "Ornikar", "Selency", "Lalilo", "Klaxoon", "Agorize", "Station F", "Sencrop", "Javelot", "Mirakl", "Akeneo", "Contentful", "Sendinblue", "Alma", "Fygr", "Kard", "Ledger", "Coinhouse", "Paymium", "Lydia", "Kandbaz", "Malt", "Comet", "Crème de la Crème", "Freework", "Hopwork", "Jobypepper", "Side", "Qapa", "Mister Temp", "StaffMe", "Gojob", "Brigad", "Extracadabra"];

async function loadCompanies(): Promise<Company[]> {
  const file = join(WORK_DIR, "companies.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const seen = new Map<string, Company>();
  const add = (c: Company) => { const k = norm(c.name).replace(/[^a-z0-9]/g, ""); if (k.length >= 3 && !seen.has(k)) seen.set(k, c); };
  for (const name of SEED_BRANDS) add({ name, names: [name] });
  for (const q of QUERIES) {
    for (let page = 1; page <= 400; page++) {
      const res = await fetchRetry(`${SEARCH}?${q}&etat_administratif=A&per_page=25&page=${page}`);
      const data = res?.ok ? await res.json().catch(() => null) : null;
      if (!data?.results?.length) break;
      for (const r of data.results) {
        const names = [r.nom_raison_sociale, ...(r.siege?.liste_enseignes || []).slice(0, 2)].filter(Boolean) as string[];
        add({ name: r.nom_raison_sociale || r.nom_complet, names, acronym: r.sigle || undefined });
      }
      process.stdout.write(`\r${q.slice(0, 40).padEnd(40)} page ${page}/${data.total_pages} — ${seen.size} entreprises`);
      if (page >= data.total_pages) break;
      await sleep(160); // limite de l'API : 7 requêtes par seconde
    }
    process.stdout.write("\n");
  }
  const list = Array.from(seen.values());
  writeFileSync(file, JSON.stringify(list));
  return list;
}

// ---------------------------------------------------------------------------
// 2. Identifiants candidats
// ---------------------------------------------------------------------------
const LEGAL = /\b(sa|sas|sasu|sarl|se|sca|snc|eurl|gie|scop|groupe|group|holding|france|societe|ste|compagnie|cie|et|de|du|des|la|le|les|l|d|international|europe|services?|industries)\b/g;

/** Identifiants « sûrs » (nom complet) et identifiants courts (premier mot, sigle) qui exigent une vérification du nom. */
export function slugCandidates(c: Company): { slug: string; strict: boolean }[] {
  const out = new Map<string, boolean>();
  for (const raw of c.names) {
    const n = norm(raw).replace(/\(.*?\)/g, " ").replace(/['’]/g, "").replace(/&/g, " ");
    const words = n.replace(LEGAL, " ").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const joined = words.join("");
    if (joined.length >= 4 && words.length <= 4) out.set(joined, out.get(joined) ?? false);
    if (words.length > 1 && words.length <= 4) out.set(words.join("-"), out.get(words.join("-")) ?? false);
    if (words.length > 1 && words[0].length >= 5) out.set(words[0], true);
  }
  if (c.acronym && /^[A-Za-z0-9]{3,8}$/.test(c.acronym)) out.set(c.acronym.toLowerCase(), true);
  return Array.from(out, ([slug, strict]) => ({ slug, strict }));
}

/** Le nom renvoyé par l'ATS correspond-il à l'entreprise ? */
function nameMatches(atsName: string | undefined, c: Company): boolean {
  if (!atsName) return false;
  const tokens = (s: string) => new Set(norm(s).replace(LEGAL, " ").split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
  const a = tokens(atsName);
  return c.names.concat(c.acronym || []).some((n) => Array.from(tokens(n)).some((t) => a.has(t)));
}

// ---------------------------------------------------------------------------
// 3. Test sur chaque ATS
// ---------------------------------------------------------------------------
interface Probe { jobs: number; name?: string }
const SLUG_ATS: Exclude<AtsKind, "workday">[] = ["greenhouse", "lever", "ashby", "smartrecruiters", "recruitee", "teamtailor"];
/** ATS qui renvoient le nom de l'entreprise (identifiants courts acceptés si le nom correspond). */
const NAMED: Set<AtsKind> = new Set(["greenhouse", "smartrecruiters", "recruitee", "teamtailor"]);

async function probe(ats: AtsKind, slug: string): Promise<Probe | null> {
  const company: AtsCompany = { name: slug, ats, slug };
  const s = encodeURIComponent(slug);
  const json = async (url: string) => {
    const res = await fetchRetry(url, { headers: { Accept: "application/json" } });
    if (!res || !res.ok) return null;
    return res.json().catch(() => null);
  };
  switch (ats) {
    case "greenhouse": {
      const d = await json(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`);
      if (!d?.jobs?.length) return null;
      return { jobs: d.jobs.filter((j: any) => normalizeGreenhouseJob(j, company)).length, name: d.jobs[0]?.company_name };
    }
    case "lever": {
      const d = await json(`https://api.lever.co/v0/postings/${s}?mode=json`);
      if (!Array.isArray(d) || !d.length) return null;
      return { jobs: d.filter((j: any) => normalizeLeverJob(j, company)).length };
    }
    case "ashby": {
      const d = await json(`https://api.ashbyhq.com/posting-api/job-board/${s}`);
      if (!d?.jobs?.length) return null;
      return { jobs: d.jobs.filter((j: any) => normalizeAshbyJob(j, company)).length };
    }
    case "smartrecruiters": {
      const d = await json(`https://api.smartrecruiters.com/v1/companies/${s}/postings?country=fr&limit=1`);
      if (!d?.totalFound) return null;
      return { jobs: d.totalFound, name: d.content?.[0]?.company?.name };
    }
    case "recruitee": {
      const d = await json(`https://${s}.recruitee.com/api/offers/`);
      if (!d?.offers?.length) return null;
      return { jobs: d.offers.filter((o: any) => normalizeRecruiteeJob(o, company)).length, name: d.offers[0]?.company_name };
    }
    case "teamtailor": {
      const res = await fetchRetry(`https://${s}.teamtailor.com/jobs.rss`);
      if (!res || !res.ok) return null;
      const xml = await res.text();
      const name = xml.match(/<channel>\s*<title>([^<]*)<\/title>/)?.[1];
      return { jobs: parseTeamtailorRss(xml, company).length, name };
    }
    default:
      return null;
  }
}

async function pool<T>(items: T[], n: number, run: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      await run(items[i], i);
    }
  }));
}

const pretty = (s: string) => s.toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (_, p, l) => p + l.toUpperCase());

async function main() {
  const companies = (await loadCompanies()).slice(0, LIMIT);
  console.log(`${companies.length} entreprises à tester`);

  const cacheFile = join(WORK_DIR, "probes.json");
  const cache: Record<string, Probe | null> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const tasks: { ats: AtsKind; slug: string }[] = [];
  const seenTask = new Set<string>();
  for (const c of companies) for (const { slug, strict } of slugCandidates(c)) for (const ats of SLUG_ATS) {
    // Identifiant court (premier mot, sigle) : seulement sur les ATS qui permettent de vérifier le nom
    if (strict && !NAMED.has(ats)) continue;
    const k = `${ats}:${slug}`;
    if (!seenTask.has(k) && !(k in cache)) { seenTask.add(k); tasks.push({ ats, slug }); }
  }
  console.log(`${tasks.length} identifiants à interroger (${Object.keys(cache).length} déjà en cache)`);

  let done = 0, found = 0;
  const started = Date.now();
  await pool(tasks, CONCURRENCY, async ({ ats, slug }) => {
    const r = await probe(ats, slug).catch(() => null);
    cache[`${ats}:${slug}`] = r;
    if (r?.jobs) found++;
    if (++done % 250 === 0 || done === tasks.length) {
      const rate = done / ((Date.now() - started) / 1000);
      process.stdout.write(`\r${done}/${tasks.length} — ${found} sites avec offres en France — ${rate.toFixed(0)} req/s   `);
      writeFileSync(cacheFile, JSON.stringify(cache));
    }
  });
  writeFileSync(cacheFile, JSON.stringify(cache));
  process.stdout.write("\n");

  // Attribution : une entreprise peut avoir plusieurs sites (on les garde tous), un site n'appartient qu'à une entreprise
  const result = new Map<string, AtsCompany & { jobs: number }>();
  for (const c of companies) {
    for (const { slug, strict } of slugCandidates(c)) for (const ats of SLUG_ATS) {
      const r = cache[`${ats}:${slug}`];
      if (!r?.jobs) continue;
      if (strict && !(NAMED.has(ats) && nameMatches(r.name, c))) continue;
      if (!strict && NAMED.has(ats) && r.name && !nameMatches(r.name, c) && r.name.toLowerCase() !== slug) continue;
      const key = `${ats}:${slug}`;
      if (!result.has(key)) result.set(key, { name: r.name && nameMatches(r.name, c) ? r.name.trim() : pretty(c.name), ats, slug, jobs: r.jobs });
    }
  }
  const list = Array.from(result.values()).sort((a, b) => b.jobs - a.jobs);
  mkdirSync(dirname(OUT), { recursive: true });
  const rows = list.map(({ name, ats, slug, jobs }) => `  ${JSON.stringify({ name, ats, slug, jobs })}`).join(",\n");
  writeFileSync(OUT, `// Généré par \`npm run discover:sites\` le ${new Date().toISOString().slice(0, 10)} : ne pas modifier à la main.
// ${list.length} sites carrières, ${list.reduce((s, c) => s + c.jobs, 0)} offres en France au moment de la découverte.
import type { AtsCompany } from "../careerSitesDirectory.ts";

export const DISCOVERED_CAREER_SITES: (AtsCompany & { jobs?: number })[] = [
${rows}
];
`);
  const byAts: Record<string, number> = {};
  for (const c of list) byAts[c.ats] = (byAts[c.ats] || 0) + 1;
  console.log(`${list.length} sites carrières retenus, ${list.reduce((s, c) => s + c.jobs, 0)} offres en France`, byAts);
  console.log(`→ ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
