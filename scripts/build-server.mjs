// Construit build/server/server.cjs avec l'API JavaScript d'esbuild.
// Hors de dist/ (servi publiquement) : le code serveur et sa source map ne sont jamais téléchargeables.
// (Appeler node_modules/esbuild/bin/esbuild avec « node » échoue sous Linux/macOS, où ce fichier est un binaire natif.)
import { build } from "esbuild";

const common = { bundle: true, platform: "node", format: "cjs", packages: "external", sourcemap: true, logLevel: "info" };
// Serveur web, puis worker d'auto-candidature (processus séparé, déployé à part)
await build({ ...common, entryPoints: ["server.ts"], outfile: "build/server/server.cjs" });
await build({ ...common, entryPoints: ["server/worker.ts"], outfile: "build/server/worker.cjs" });
