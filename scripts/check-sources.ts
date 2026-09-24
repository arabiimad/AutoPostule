/**
 * Vérifie les sources d'offres configurées dans .env avec une vraie recherche.
 *   npm run check:sources -- "développeur web" Lyon alternance
 * Affiche, pour chaque source : nombre d'offres, erreur éventuelle, et un exemple.
 */
import "dotenv/config";
import { searchRealJobs, getSourceStatus, SOURCE_LABELS, type SourceKey } from "../server/jobSources.ts";

const [query = "développeur web", location = "Paris", contractType = "tous"] = process.argv.slice(2);

const status = getSourceStatus();
console.log(`\nRecherche test : « ${query} » à ${location} (contrat : ${contractType})\n`);
if (!Object.values(status).some(Boolean)) {
  console.log("Aucune source configurée dans .env : l'application fonctionne en mode démonstration.");
  process.exit(0);
}

const started = Date.now();
const r = await searchRealJobs({ query, location, contractType, radius: 30 });
console.log(`Terminé en ${((Date.now() - started) / 1000).toFixed(1)} s — ${r.jobs.length} offres après fusion des doublons${r.hasMore ? " (d'autres pages disponibles)" : ""}.\n`);

for (const key of Object.keys(SOURCE_LABELS) as SourceKey[]) {
  const s = r.sources[key];
  const label = SOURCE_LABELS[key].padEnd(40);
  if (!s.enabled) console.log(`  ○ ${label} non configurée`);
  else if (s.error) console.log(`  ✗ ${label} ERREUR : ${s.error}`);
  else if (s.skipped) console.log(`  – ${label} ignorée : ${s.skipped}`);
  else console.log(`  ✓ ${label} ${s.count} offre(s)`);
}

if (r.warnings.length) {
  console.log("\nAvertissements :");
  r.warnings.forEach((w) => console.log(`  ! ${w}`));
}

const offers = r.jobs.filter((j) => !j.isSpontaneous).slice(0, 5);
const spontaneous = r.jobs.filter((j) => j.isSpontaneous);
console.log("\nPremières offres :");
offers.forEach((j) => console.log(`  • ${j.title} — ${j.company} (${j.location}) [${j.source}]`));
if (spontaneous.length) console.log(`\n+ ${spontaneous.length} entreprise(s) qui recrutent en alternance sans offre publiée (candidatures spontanées).`);
console.log("");
