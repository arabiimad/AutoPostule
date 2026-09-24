# Reprendre Candida dans Codex Cloud

Ce dépôt contient le code de la plateforme, y compris les changements du parcours CV du 23 septembre 2026. Il ne contient pas de clés privées de l'environnement local. La préparation du dépôt ne signifie pas qu'une tâche cloud est déjà lancée.

## Environnement

- Dépôt privé GitHub ou GitLab connecté à Codex Cloud.
- Node.js 22 ou supérieur ; installation avec le package-lock.json existant.
- Script de configuration : `bash scripts/setup-codex-cloud.sh`.
- Variables facultatives : `INSTALL_LATEX=1` pour installer TeX Live et Poppler ; `INSTALL_BROWSER=1` pour Chromium/Playwright.
- L'installation LaTeX complète peut être volumineuse (notamment les polices moderncv). Le script cible Ubuntu/Debian et requiert root ou sudo pour les paquets système.
- Aucun secret n'est nécessaire pour les tests simulés, le build et le rendu LaTeX déterministe.
- Les appels réels Gemini requièrent GEMINI_API_KEY, à configurer séparément via les contrôles de secrets de l'environnement, jamais dans Git. Le script ne copie ni n'affiche de clé.

## État validé localement

52 tests réussis, un test PDF ignoré faute de compilateur ; TypeScript et build réussis. Aucun test Linux ou appel Gemini réel n'a encore été exécuté pour cette migration.

Le parcours `/api/tailor/latex` appelle `server/cvTailoring.ts` pour analyser l'offre, reformuler les puces avec leurs références et contrôler les propositions. Le serveur rend ensuite le template fixe de `server/latex.ts`. Les métadonnées source sont conservées. La vérification IA n'est pas une garantie absolue de fidélité.

## Instruction de reprise

Poursuivre l'amélioration du parcours CV de Candida. Lire CODEX_CLOUD.md, server/cvTailoring.ts, server/latex.ts et tests/cvTailoring.test.ts. Exécuter les tests, compiler les trois templates avec un profil synthétique et inspecter les PDF. Ajouter les projets personnels actuellement absents du rendu et un diagnostic de pagination/débordement ; conserver les faits du profil et la lisibilité. Si un CV LaTeX/PDF de référence utilisateur n'est pas fourni, utiliser une fixture synthétique et ne pas prétendre égaler son rendu Gemini. Ne pas déployer l'application ni envoyer de candidatures. Rapporter les modifications, tests et limites ; conserver les changements dans le dépôt pour reprise depuis le téléphone.

## Commandes

```bash
npm run lint
npm test
npm run build
# Après installation de Chromium :
npm run test:e2e
```

La tâche cloud travaille sur son checkout distant. Les modifications locales futures devront être poussées vers le dépôt ; les modifications cloud devront être récupérées sur le PC.
