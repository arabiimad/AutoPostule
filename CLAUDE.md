# AutoPostule — contexte pour Claude Code

Application commerciale (freemium) d'aide à la recherche d'emploi et d'alternance : recherche d'offres multi-sources, CV et lettre adaptés par l'IA, suivi des candidatures, préparation d'entretien. Cible : candidats francophones de tous métiers (pas seulement la tech), souvent peu à l'aise avec l'informatique, souvent sur mobile.

## Pile technique
- Interface : React 19, Vite, Tailwind v4 (mode sombre par variables CSS sous `.dark`), `src/`
- Serveur : Express (`server.ts` démarre, `server/app.ts` assemble, `server/routes/*` par domaine), bundlé par `scripts/build-server.mjs`
- IA : Gemini (`server/ai.ts`, chaîne CV `server/cvPipeline.ts` : analyse de l'offre → contenu adapté → garde-fous → relecture → mise en forme)
- Données : Supabase PostgreSQL UE (`src/data/cloud.ts`, `supabase/migrations/`, RLS), session locale sans compte
- Forfaits : `server/plans.ts` (quotas, 402 QUOTA_EXCEEDED), Stripe `server/stripe.ts`, `server/routes/account.ts`
- PDF : rendu Web HTML→PDF Chromium (`server/pdf.ts`) ou LaTeX (`server/latex.ts`)

## Commandes
- `npm run dev` · `npm run lint` (types) · `npm test` (unitaires) · `npm run build`
- `npm run test:e2e` (parcours complet, sources et IA simulées ; après build)
- `npm run test:supabase` (test réel contre Supabase, comptes de test créés puis supprimés)
- Chromium : `PW_CHROMIUM_PATH` si Playwright ne trouve pas son navigateur

## Règles non négociables
1. **Ne jamais inventer** dans un CV ou une lettre : aucun chiffre, outil, diplôme ou compétence absent du profil. Toute modification de la chaîne IA garde les garde-fous et leurs tests.
2. **Secrets** : ne jamais lire, afficher, copier ni modifier `.env`. Les clés `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_*` restent côté serveur.
3. **Données personnelles** : RLS sur toute nouvelle table ; aucune donnée de CV dans les journaux, Sentry ou PostHog.
4. **Interface en français**, ton clair et direct, vouvoiement, typographie française (espaces avant « : ; ! ? », guillemets « »).
5. **Accessibilité** : navigation clavier, libellés, contrastes AA, fenêtres avec focus piégé et Échap.
6. Chaque correction s'accompagne d'un test (unitaire ou e2e) ; `npm run lint && npm test && npm run build` doivent passer avant de conclure.
7. Pas de nouvelle dépendance sans justification ; pas de fonctionnalité promise (page Tarifs, textes) qui n'existe pas.

## Audit et qualité
- `/audit` : audit complet (code, sécurité, UX, produit) → `AUDIT.md`, sans modifier le code
- `/ux-walkthrough [persona]` : parcours réel dans un navigateur avec captures
- `/fix-audit [P0|P1|id]` : corrige les points de `AUDIT.md` par lots testés
- Référentiel de qualité : skill `high-end-quality-bar`
