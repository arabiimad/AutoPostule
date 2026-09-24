# AutoPostule — contexte pour Claude Code

Application commerciale (freemium) d'aide à la recherche d'emploi et d'alternance : recherche d'offres multi-sources, CV et lettre adaptés par l'IA, suivi des candidatures, préparation d'entretien. Cible : candidats francophones de tous métiers (pas seulement la tech), souvent peu à l'aise avec l'informatique, souvent sur mobile.

## Pile technique (état actuel du dépôt)

- Interface : React 19, Vite, Tailwind v4 (mode sombre par variables CSS sous `.dark`, voir `src/index.css`), `src/` (vues dans `src/components/`, appels API dans `src/utils/api.ts`)
- Serveur : Express, tout dans `server.ts` (routes `/api/*`) avec les modules de `server/` ; bundlé par `scripts/build-server.mjs` vers `dist/server.cjs`
- IA : Gemini (`@google/genai`, appels dans `server.ts`) ; chaîne CV `server/cvPipeline.ts` (analyse de l'offre → contenu adapté → garde-fous → relecture → mise en forme) et `server/cvTailoring.ts` (route `/api/tailor/latex`)
- Offres : `server/jobSources.ts` (sources multiples, filtrage)
- Données : Firebase (Auth + Firestore, `src/firebase.ts`, `firestore.rules`), vérification des jetons côté serveur `server/auth.ts`, stockage serveur `server/store.ts`
- PDF : rendu Web HTML→PDF Chromium (`server/pdf.ts`) ou LaTeX (`server/latex.ts`) ; export Word `server/docx.ts`

### Cible prévue (pas encore dans le code)

Ne pas supposer que ces éléments existent ; vérifier avant d'y faire référence :

- Découpage `server/app.ts` + `server/routes/*` par domaine, IA regroupée dans `server/ai.ts`
- Supabase PostgreSQL UE (`src/data/cloud.ts`, `supabase/migrations/`, RLS) à la place de Firebase, session locale sans compte
- Forfaits et quotas `server/plans.ts` (402 `QUOTA_EXCEEDED`), Stripe `server/stripe.ts`, `server/routes/account.ts`
- Script `npm run test:supabase`
- Commandes `/audit`, `/ux-walkthrough`, `/fix-audit` et skill `high-end-quality-bar` (non présents dans `.claude/`)

## Commandes

- `npm run dev` · `npm run lint` (types) · `npm test` (unitaires, `tests/*.test.ts`) · `npm run build`
- `npm run test:e2e` : parcours complet, sources et IA simulées (après build)
- `npm run check:sources` / `npm run check:ai` : vérifications réelles des sources et de l'IA (réseau, clés)
- Chromium : `PW_CHROMIUM_PATH` si Playwright ne trouve pas son navigateur

## Règles non négociables

1. Ne jamais inventer dans un CV ou une lettre : aucun chiffre, outil, diplôme ou compétence absent du profil. Toute modification de la chaîne IA garde les garde-fous et leurs tests (`tests/cvPipeline.test.ts`, `tests/cvTailoring.test.ts`).
2. Secrets : ne jamais lire, afficher, copier ni modifier `.env` (seul `.env.example` est consultable). Les clés serveur (`GEMINI_API_KEY`, identifiants Firebase Admin, et plus tard `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_*`) restent côté serveur.
3. Données personnelles : règles d'accès sur toute nouvelle collection ou table (`firestore.rules` aujourd'hui, RLS avec Supabase) ; aucune donnée de CV dans les journaux, Sentry ou PostHog.
4. Interface en français, ton clair et direct, vouvoiement, typographie française (espaces avant « : ; ! ? », guillemets « »).
5. Accessibilité : navigation clavier, libellés, contrastes AA, fenêtres avec focus piégé et Échap.
6. Chaque correction s'accompagne d'un test (unitaire ou e2e) ; `npm run lint && npm test && npm run build` doivent passer avant de conclure.
7. Pas de nouvelle dépendance sans justification ; pas de fonctionnalité promise (page Tarifs, textes) qui n'existe pas.
