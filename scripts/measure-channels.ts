/**
 * Mesure : vers quoi pointent les boutons « Postuler » des offres (lecture seule, aucun envoi).
 * Dit quel connecteur de candidature construire ensuite : le plus gros volume d'abord.
 *
 *   npm run measure:channels                         échantillon en direct (API France Travail, clés du .env)
 *   npm run measure:channels -- --departements 75,13,69 --pages 4
 *   npm run measure:channels -- --db                 base d'offres (AUTOMATION_DATABASE_URL, après collecte)
 *   npm run measure:channels -- --json rapport.json  rapport détaillé
 */
import dotenv from "dotenv";
import fs from "node:fs";
import type { JobOffer } from "../src/types.ts";
import { normalizeFtJob, ftSearchRaw } from "../server/jobSources.ts";
import { AUTOMATED_KINDS, familyInfo } from "../server/ingest/applyHosts.ts";
import { MemoryOfferStore, PgOfferStore, toOfferRow, type ChannelStat } from "../server/ingest/offerStore.ts";
import { FT_PAGE, ftDate } from "../server/ingest/franceTravail.ts";

dotenv.config();
const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (name: string) => args.includes(`--${name}`);

// Échantillon varié : grandes villes et départements ruraux, tous métiers
const DEFAULT_DEPS = ["75", "13", "69", "59", "33", "31", "44", "67", "35", "06", "84", "63", "87", "23", "48", "971"];

async function liveSample(): Promise<{ stats: ChannelStat[]; offers: JobOffer[] }> {
  if (!process.env.FT_CLIENT_ID || !process.env.FT_CLIENT_SECRET) {
    console.error("FT_CLIENT_ID / FT_CLIENT_SECRET manquants dans .env : impossible d'interroger France Travail.");
    process.exit(1);
  }
  const deps = (arg("departements") || DEFAULT_DEPS.join(",")).split(",").map((d) => d.trim()).filter(Boolean);
  const pages = Math.max(1, Math.min(21, Number(arg("pages")) || 2));
  const store = new MemoryOfferStore();
  const offers: JobOffer[] = [];
  const to = new Date();
  const from = new Date(to.getTime() - 31 * 86_400_000);
  for (const dep of deps) {
    for (let p = 0; p < pages; p++) {
      const qs = new URLSearchParams({ departement: dep, range: `${p * FT_PAGE}-${p * FT_PAGE + FT_PAGE - 1}`, sort: "1", minCreationDate: ftDate(from), maxCreationDate: ftDate(to) });
      const r = await ftSearchRaw(qs);
      if (r.status >= 400) { console.warn(`  département ${dep} : erreur ${r.status}`); break; }
      const jobs = r.offers.map(normalizeFtJob).filter((j): j is JobOffer => !!j);
      offers.push(...jobs);
      await store.upsertOffers(jobs.map(toOfferRow), new Date().toISOString());
      process.stdout.write(`\r  ${offers.length} offres lues (département ${dep})…      `);
      if (r.offers.length < FT_PAGE) break;
      await new Promise((res) => setTimeout(res, 350));
    }
  }
  process.stdout.write("\n");
  return { stats: await store.channelStats(), offers };
}

const pct = (n: number, total: number) => `${((100 * n) / Math.max(1, total)).toFixed(1).padStart(5)} %`;

function report(stats: ChannelStat[], offers: JobOffer[] | null) {
  const total = stats.reduce((a, s) => a + s.count, 0);
  if (!total) { console.log("Aucune offre à mesurer."); return {}; }
  const automated = stats.filter((s) => AUTOMATED_KINDS.has(s.kind)).reduce((a, s) => a + s.count, 0);

  console.log(`\n${total} offres mesurées.`);
  console.log(`Candidature automatique déjà possible (email, La bonne alternance, Lever, Greenhouse) : ${automated} (${pct(automated, total).trim()})\n`);

  // Par famille de page de candidature
  const byHost = new Map<string, number>();
  for (const s of stats) byHost.set(s.host, (byHost.get(s.host) || 0) + s.count);
  const rows = [...byHost.entries()].sort((a, b) => b[1] - a[1]);
  console.log("Pages de candidature (du plus gros volume au plus petit) :");
  for (const [host, n] of rows.slice(0, 40)) {
    const info = familyInfo(host);
    const label = host === "email" ? "Email de candidature publié" : info ? `${info.label} (${info.kind === "ats" ? "logiciel de recrutement" : info.kind === "platform" ? "plateforme, pas d'envoi automatique" : info.kind === "public" ? "service public" : "intérim"})` : host.startsWith("autre:") ? `Site inconnu : ${host.slice(6)}` : host;
    console.log(`  ${pct(n, total)}  ${String(n).padStart(6)}  ${label}`);
  }

  // Logiciels de recrutement non encore pris en charge : les prochains connecteurs
  const next = rows.filter(([h]) => familyInfo(h)?.kind === "ats" && !["lever", "greenhouse"].includes(h));
  if (next.length) {
    console.log("\nProchains connecteurs de formulaire à construire (par volume) :");
    for (const [h, n] of next.slice(0, 10)) console.log(`  ${pct(n, total)}  ${familyInfo(h)!.label}`);
  }
  const unknown = rows.filter(([h]) => h.startsWith("autre:"));
  if (unknown.length) {
    const u = unknown.reduce((a, [, n]) => a + n, 0);
    console.log(`\nSites inconnus : ${u} offres (${pct(u, total).trim()}) sur ${unknown.length} domaines — à identifier (logiciel de recrutement caché derrière le site de l'entreprise ?).`);
  }

  // Offres France Travail : partenaires d'origine
  if (offers) {
    const partners = new Map<string, number>();
    for (const o of offers) partners.set(o.sourcePartner || "France Travail (offre déposée directement)", (partners.get(o.sourcePartner || "France Travail (offre déposée directement)") || 0) + 1);
    console.log("\nOrigine des offres France Travail :");
    for (const [p, n] of [...partners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${pct(n, offers.length)}  ${p}`);
    const withEmail = offers.filter((o) => o.contactEmail).length;
    const byEmail = stats.filter((st) => st.kind === "email").reduce((a, st) => a + st.count, 0);
    console.log(`\nCandidature par email : ${byEmail} offres (${pct(byEmail, total).trim()}), dont ${withEmail} avec l'adresse dans le champ « contact » de France Travail ; les autres citent l'adresse dans le texte de l'offre.`);
  }
  return { total, automated, byHost: Object.fromEntries(rows), stats };
}

const out = has("db")
  ? await (async () => {
      const db = PgOfferStore.fromEnv();
      if (!db) { console.error("AUTOMATION_DATABASE_URL manquante."); process.exit(1); }
      const counts = await db.countActive();
      console.log(`Base d'offres : ${counts.total} offres actives`, counts.bySource);
      const r = report(await db.channelStats(), null);
      await db.close();
      return r;
    })()
  : await (async () => { const { stats, offers } = await liveSample(); return report(stats, offers); })();

const jsonPath = arg("json");
if (jsonPath) {
  fs.writeFileSync(jsonPath, JSON.stringify({ at: new Date().toISOString(), ...out }, null, 2));
  console.log(`\nRapport écrit dans ${jsonPath}`);
}
