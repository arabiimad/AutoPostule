# Kareer — contexte pour Claude Code

Application commerciale (freemium) d'aide à la recherche d'emploi et d'alternance : recherche d'offres multi-sources, CV et lettre adaptés par l'IA, suivi des candidatures, préparation d'entretien. Cible : candidats francophones de tous métiers (pas seulement la tech), souvent peu à l'aise avec l'informatique, souvent sur mobile.

## Pile technique
- Interface : React 19, Vite, Tailwind v4 (mode sombre par variables CSS sous `.dark`), `src/`
- Serveur : Express (`server.ts` démarre, `server/app.ts` assemble, `server/routes/*` par domaine), bundlé par `scripts/build-server.mjs`
- IA : Gemini (`server/ai.ts`, messages d'erreur lisibles `server/aiErrors.ts`, chaîne CV `server/cvPipeline.ts` : analyse de l'offre → contenu adapté → garde-fous → relecture → mise en forme)
- Données : Supabase PostgreSQL UE (`src/data/cloud.ts`, `supabase/migrations/`, RLS), session locale sans compte
- Forfaits : `server/plans.ts` (quotas, 402 QUOTA_EXCEEDED), Stripe `server/stripe.ts`, `server/routes/account.ts`
- PDF : rendu Web HTML→PDF Chromium (`server/pdf.ts`) ou LaTeX (`server/latex.ts` : modèles Classique, Photo, Moderne, Compact, et lettre de motivation)
- Outils : publics sans compte ni IA (vérificateur de CV ATS, comparaison CV / offre : `server/atsCheck.ts`, `/verificateur-cv-ats`, `/match-cv-offre`) ; réservé aux comptes « Adapter mon CV à cette offre » (`/api/tools/offer-match`). Routes dans `server/routes/tools.ts`
- Marque Kareer : logo `src/components/KareerLogo.tsx`, animation de chargement `src/components/BrandLoader.tsx` et écran de démarrage dans `index.html`

## Commandes
- `npm run dev` · `npm run lint` (types) · `npm test` (unitaires) · `npm run build`
- `npm run test:e2e` (parcours complet, sources et IA simulées ; après build)
- `AUTOMATION_PG="-h <hôte> -p <port> -U postgres" npm test` : migrations et file de tâches de l'auto-candidature testées sur un vrai PostgreSQL (ignorés sans cette variable)
- `npm run test:supabase` (test réel contre Supabase, comptes de test créés puis supprimés)
- `npm run check:sources` / `npm run check:ai` : vérifications réelles des sources et de l'IA (réseau, clés)
- Chromium : `PW_CHROMIUM_PATH` si Playwright ne trouve pas son navigateur

## Règles non négociables
1. **Ne jamais inventer** dans un CV ou une lettre : aucun chiffre, outil, diplôme ou compétence absent du profil. Toute modification de la chaîne IA garde les garde-fous et leurs tests (`tests/cvPipeline.test.ts`, `tests/latex.test.ts`).
2. **Secrets** : ne jamais lire, afficher, copier ni modifier `.env`. Les clés `GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_*` restent côté serveur.
3. **Données personnelles** : RLS sur toute nouvelle table ; aucune donnée de CV dans les journaux, Sentry ou PostHog (la photo du profil n'est jamais envoyée à l'IA).
4. **Interface en français**, ton clair et direct, vouvoiement, typographie française (espaces avant « : ; ! ? », guillemets « »).
5. **Accessibilité** : navigation clavier, libellés, contrastes AA, fenêtres avec focus piégé et Échap.
6. Chaque correction s'accompagne d'un test (unitaire ou e2e) ; `npm run lint && npm test && npm run build` doivent passer avant de conclure.
7. Pas de nouvelle dépendance sans justification ; pas de fonctionnalité promise (page Tarifs, textes) qui n'existe pas.

## Audit et qualité
- `/audit` : audit complet (code, sécurité, UX, produit) → `AUDIT.md`, sans modifier le code
- `/ux-walkthrough [persona]` : parcours réel dans un navigateur avec captures
- `/fix-audit [P0|P1|id]` : corrige les points de `AUDIT.md` par lots testés
- Référentiel de qualité : skill `high-end-quality-bar`
