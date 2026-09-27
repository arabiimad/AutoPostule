// Construit build/server/server.cjs avec l'API JavaScript d'esbuild.
// Hors de dist/ (servi publiquement) : le code serveur et sa source map ne sont jamais téléchargeables.
// (Appeler node_modules/esbuild/bin/esbuild avec « node » échoue sous Linux/macOS, où ce fichier est un binaire natif.)
import { build } from "esbuild";

await build({
  entryPoints: ["server.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  sourcemap: true,
  outfile: "build/server/server.cjs",
  logLevel: "info"
});
