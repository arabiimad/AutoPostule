// Construit dist/server.cjs avec l'API JavaScript d'esbuild.
// (Appeler node_modules/esbuild/bin/esbuild avec « node » échoue sous Linux/macOS, où ce fichier est un binaire natif.)
import { build } from "esbuild";

await build({
  entryPoints: ["server.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  sourcemap: true,
  outfile: "dist/server.cjs",
  logLevel: "info"
});
