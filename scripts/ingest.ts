/**
 * Collecte manuelle des offres France Travail dans la base d'offres (le worker le fait aussi en continu).
 *
 *   npm run ingest:ft                       incrémentale (nouveautés depuis la dernière collecte)
 *   npm run ingest:ft -- --full             complète (toutes les offres en ligne ; offres retirées désactivées)
 *   npm run ingest:ft -- --departements 13,84
 */
import dotenv from "dotenv";
import { PgOfferStore } from "../server/ingest/offerStore.ts";
import { syncFranceTravail } from "../server/ingest/franceTravail.ts";

dotenv.config();
const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

if (!process.env.FT_CLIENT_ID || !process.env.FT_CLIENT_SECRET) {
  console.error("FT_CLIENT_ID / FT_CLIENT_SECRET manquants.");
  process.exit(1);
}
const store = PgOfferStore.fromEnv();
if (!store) {
  console.error("AUTOMATION_DATABASE_URL manquante (base Supabase, migration 007 appliquée).");
  process.exit(1);
}

const departements = arg("departements")?.split(",").map((d) => d.trim()).filter(Boolean);
const summary = await syncFranceTravail(store, {
  mode: args.includes("--full") ? "full" : "incremental",
  departements,
  rps: Number(process.env.FT_SYNC_RPS) || undefined,
  log: (event, data) => console.log(event, JSON.stringify(data))
});
console.log(JSON.stringify(summary, null, 2));
console.log(await store.countActive());
await store.close();
process.exit(summary.errors.length ? 2 : 0);
