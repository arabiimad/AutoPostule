/**
 * Collecte des offres publiées sur les sites des employeurs (JobPosting ; le worker le fait aussi en continu).
 *
 *   npm run ingest:sites -- --test exemple.fr,autre.fr   essai sans base : affiche les offres trouvées
 *   npm run ingest:sites                                 sites des employeurs des offres collectées (40 par défaut)
 *   npm run ingest:sites -- --max 200                    plus de sites
 */
import dotenv from "dotenv";
import { PgOfferStore } from "../server/ingest/offerStore.ts";
import { crawlSite, siteSeeds, syncCareerSites } from "../server/ingest/careerSites.ts";

dotenv.config();
const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const test = arg("test");
if (test) {
  for (const site of siteSeeds([], test)) {
    const r = await crawlSite(site);
    console.log(`\n${site} : ${r.offers.length} offre(s), ${r.pages} page(s) lue(s)${r.blocked ? ` — ${r.blocked}` : ""}`);
    for (const o of r.offers.slice(0, 15)) console.log(`  • ${o.title} — ${o.location} — ${o.contractType}${o.contactEmail ? ` — ${o.contactEmail}` : ""}\n    ${o.applyUrl}`);
    if (r.boards.length) console.log(`  Pages carrière hébergées : ${r.boards.slice(0, 5).join(", ")}`);
  }
  process.exit(0);
}

const store = PgOfferStore.fromEnv();
if (!store) {
  console.error("AUTOMATION_DATABASE_URL manquante (base Supabase, migration 007 appliquée).");
  process.exit(1);
}
const seeds = siteSeeds(await store.employerUrls());
console.log(`${seeds.length} sites d'employeurs connus.`);
const summary = await syncCareerSites(store, seeds, {
  maxSites: Number(arg("max")) || 40,
  log: (event, data) => console.log(event, JSON.stringify(data))
});
console.log(JSON.stringify(summary, null, 2));
console.log(await store.countActive());
await store.close();
