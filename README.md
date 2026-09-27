# Kareer

Recherche d'offres multi-sources, CV LaTeX et lettre adaptés à chaque offre, suivi des candidatures, relances et préparation aux entretiens.

## Démarrer

Prérequis : Node.js 22 (ou 20+).

```bash
npm install
cp .env.example .env      # puis renseigner les clés (voir ci-dessous)
npm run dev               # http://localhost:3000
```

Production :

```bash
npm run build             # interface publique (dist/) + serveur privé (build/server/server.cjs)
npm start                 # sert dist/ ; port = variable PORT (3000 par défaut)
```

## Scripts

| Commande | Rôle |
|---|---|
| `npm run dev` | Serveur + interface avec rechargement (Vite) |
| `npm run build` / `npm start` | Construction puis lancement en production |
| `npm run lint` | Vérification des types TypeScript |
| `npm test` | Tests unitaires (sources, fusion des doublons, score, LaTeX, statistiques, import Word…) |
| `npm run test:e2e` | Parcours complet dans un vrai navigateur, sources simulées (après `npm run build` et `npx playwright install chromium`) |
| `npm run check:sources -- "développeur web" Lyon alternance` | Teste vos vraies clés d'API : offres par source, erreurs, avertissements |
| `npm run check:ai` | Teste la clé Gemini (modèles accessibles) et la génération d'un CV d'exemple |
| `npm run test:supabase` | Test réel contre votre projet Supabase : connexion, profil, candidatures, cloisonnement RLS (comptes de test créés puis supprimés) |

Intégration continue : `.github/workflows/ci.yml` (types, tests, build et tests de bout en bout à chaque push sur GitHub).

## Sources d'offres (.env)

| Source | Contenu | Variables |
|---|---|---|
| France Travail | Offres d'emploi (CDI, CDD, alternance…) | `FT_CLIENT_ID`, `FT_CLIENT_SECRET` |
| La bonne alternance | Offres en alternance + entreprises qui recrutent sans offre publiée (candidatures spontanées) | `LBA_API_KEY` |
| JSearch (Google for Jobs) | Offres publiées sur LinkedIn, Indeed, Welcome to the Jungle, Glassdoor… | `JSEARCH_API_KEY` |
| Adzuna | Agrégateur | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` |
| Jooble | Agrégateur | `JOOBLE_API_KEY` (+ `JOOBLE_HOST=https://fr.jooble.org` pour une clé française) |

Sans aucune clé, l'application fonctionne en mode démonstration (offres indicatives).

Fonctionnement :
- les codes métier ROME sont trouvés automatiquement à partir du métier saisi (service de La bonne alternance) ;
- si France Travail ne trouve rien avec les mots-clés, la recherche est relancée par code ROME ;
- les offres hors sujet des agrégateurs sont écartées et les doublons entre plateformes fusionnés ;
- « Charger plus d'offres » interroge les pages suivantes des sources ;
- Google Jobs peut être lent : au-delà de 12 s, les autres résultats s'affichent et ses offres arrivent à la recherche suivante (cache).

Quotas gratuits (JSearch ≈ 200/mois, Adzuna, Jooble ≈ 500 au total) : les résultats sont mis en cache et un avertissement apparaît à 80 % du quota (`GET /api/jobs/sources` affiche les compteurs).

## Génération du CV (qualité « Gemini »)

L'IA ne produit jamais de LaTeX ; elle ne rédige que le contenu, qui est ensuite mis en forme par des modèles fixes :

1. **Analyse de l'offre** (modèle rapide, résultat en cache 7 jours) : domaine, ton, exigences, missions, mots-clés.
2. **Adaptation du contenu** (modèle le plus puissant) : titre, accroche, puces reformulées, ordre des expériences et des compétences, en JSON.
3. **Garde-fous** : toute puce contenant un chiffre, un outil ou une compétence absents du profil est remplacée par le texte d'origine.
4. **Relecture** : une seconde passe de l'IA compare chaque puce reformulée à l'original ; toute puce qui ajoute un fait revient au texte d'origine.
5. **Mise en forme**, au choix dans le Studio :
   - **Web** (par défaut) : mise en page HTML convertie en PDF par Chromium — aperçu instantané, aucun LaTeX requis. Installer le navigateur une fois : `npx playwright install chromium` (ou `PW_CHROMIUM_PATH` vers un Chromium existant ; `WEB_PDF=off` pour désactiver). Sans Chromium, le bouton PDF passe par l'impression du navigateur.
   - **LaTeX** : modèles Classique, Moderne, Compact (pdfLaTeX, Tectonic ou Overleaf).

Dans le Studio : onglet **Contenu** (retouche de chaque puce par l'IA avec des consignes, réordonnancement, masquage), **Aperçu** intégré, changement de modèle sans perdre le contenu. `npm run check:ai` teste votre clé et affiche un CV adapté d'exemple.

Modèle Pro : l'abonnement Google AI Pro (application Gemini) ne donne pas accès à l'API. Pour utiliser `gemini-3.1-pro-preview` via l'API, activez la facturation du projet Google Cloud lié à la clé (environ 2 $ / 12 $ par million de jetons en entrée / sortie, soit quelques centimes par CV). Sans facturation, l'application passe automatiquement sur Flash.

## Comptes et base de données (Supabase)

Comptes (e-mail + mot de passe, Google en option), profils et candidatures sont stockés dans Supabase (PostgreSQL, région UE). Chaque utilisateur ne voit que ses données (règles RLS). Sans configuration, l'application fonctionne en session locale (données dans le navigateur).

1. Créez un projet sur supabase.com (région Europe).
2. SQL Editor : exécutez dans l’ordre les migrations `supabase/migrations/001_init.sql` à `007_offer_index.sql` (tables, règles RLS, file d’auto-candidature, notifications, synchronisation, facturation).
3. `.env` : `SUPABASE_URL`, `SUPABASE_ANON_KEY` (clé publishable), `SUPABASE_SERVICE_ROLE_KEY` (serveur uniquement, jamais dans le navigateur), et pour l'interface `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
4. Authentication → URL Configuration : « Site URL » = l'adresse publique de l'application (liens de confirmation et de réinitialisation).
5. Production : configurez un SMTP (Authentication → Emails) ; le service d'e-mail par défaut de Supabase est limité à quelques envois par heure.
6. Connexion Google (facultatif) : Authentication → Providers → Google, puis `VITE_AUTH_GOOGLE=on`.
7. Avant la mise en production : `npm run check:prod` vérifie les variables (sans afficher les valeurs), les migrations appliquées et l’accès à Supabase, puis affiche les adresses de retour OAuth à déclarer chez Google et Microsoft.

## Forfaits (freemium) et paiement

| | Gratuit | Premium (9,99 €/mois) |
|---|---|---|
| CV adaptés par l'IA | 3 / mois (modèle rapide) | 150 / mois (modèle Pro) |
| Lettres de motivation | 3 / mois | 150 / mois |
| Retouches et évaluations IA | 15 / mois | 600 / mois |
| Préparations d'entretien | 3 / mois | 80 / mois |
| Imports de CV | 5 / mois | 30 / mois |

- Les quotas sont vérifiés par le serveur : table `usage` (Supabase) pour les comptes, compteur par adresse IP pour les visiteurs. Une réponse sans IA (repli, erreur) n'est pas décomptée. Au-delà : réponse `402 QUOTA_EXCEEDED` et fenêtre « Passer à Premium ».
- Page **Tarifs** (`?onglet=tarifs`) : forfaits, consommation du mois, souscription et gestion de l'abonnement.
- **Profil → Mes données** : export JSON de toutes les données et suppression définitive du compte (RGPD).

Activer le paiement (Stripe) :
1. Créez un compte Stripe (mode test pour commencer), puis un produit « Kareer Premium » avec un tarif récurrent mensuel : `STRIPE_PRICE_PREMIUM=price_…`.
2. `STRIPE_SECRET_KEY=sk_test_…` (Développeurs → Clés API).
3. Webhook (Développeurs → Webhooks) vers `https://votre-domaine/api/billing/webhook`, évènements `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` : `STRIPE_WEBHOOK_SECRET=whsec_…`. En local : `stripe listen --forward-to localhost:3000/api/billing/webhook`.
4. Portail client (Paramètres → Billing → Customer portal) : activez la résiliation et la mise à jour de la carte.

## Découverte d'offres et envoi La bonne alternance (auto-candidature)

La recherche planifiée du worker ne se limite pas aux sites d'emploi (`server/discovery/`) :

- **Pages carrière des entreprises** (Greenhouse, Lever, Ashby, SmartRecruiters) : chaque lien vers l'une d'elles rencontré dans une recherche enregistre la page (liste partagée, Redis si configuré), relue ensuite pour tous les candidats. Seules les offres dont l'intitulé contient tous les mots du métier recherché sont gardées. Les offres Lever et Greenhouse partent ensuite par le formulaire déjà pris en charge.
- **Publications « on recrute »** (LinkedIn, sites d'entreprises…) via la recherche Google de Gemini : lecture des résultats publics seulement, sans connexion à LinkedIn. Une offre n'est gardée que si son lien fait partie des pages réellement consultées par la recherche : un lien inventé est écarté. L'adresse de candidature citée dans la publication est reprise.
- **France uniquement** dans cette version (`regions.ts`, prévu pour ajouter d'autres pays).
- **Tous les métiers** : une offre dont les compétences ne sont pas reconnues par le catalogue n'est plus écartée si son intitulé correspond au métier recherché ; le dossier est préparé et **validé par le candidat** (jamais d'envoi automatique à l'aveugle).

Canaux d'envoi ajoutés :
- **La bonne alternance** : API officielle `POST /job/v1/apply` (migration `006_lba_channel.sql`). Mêmes garanties que l'email : réservation, pause revérifiée, preuve, résultat incertain jamais renvoyé.
- **Adresse de candidature France Travail** (`contact.courriel` de l'offre) : envoi par email depuis la boîte du candidat.

## Base d'offres : collecte continue et mesure des canaux

Le worker alimente la table `job_offers` (migration `007_offer_index.sql`) en continu, au lieu d'interroger les sources à chaque recherche (`server/ingest/`) :

- **France Travail, y compris les offres de ses sites partenaires** : tous les départements (métropole, Corse, outre-mer). L'API renvoie au plus 3 150 résultats par recherche : quand un département dépasse, la période de création est découpée en deux, récursivement. Nouveautés toutes les heures (`INGEST_FT_EVERY_MINUTES`), balayage complet une fois par jour (`INGEST_FT_FULL_EVERY_HOURS`) : les offres qui ne sont plus en ligne deviennent inactives. Un verrou PostgreSQL garantit un seul collecteur, même avec plusieurs workers. Activation : `INGEST_FT=on`.
- Chaque offre reçoit : code métier ROME, département, site partenaire d'origine, empreinte (doublons entre sources), canal de candidature et famille de la page « Postuler » (Workday, Taleez, Indeed…), recherche plein texte en français.
- `npm run ingest:ft [-- --full --departements 13,84]` : collecte manuelle.
- **Sites des employeurs** (`INGEST_SITES=on`) : offres publiées sur les pages carrière des entreprises au format standard schema.org `JobPosting` (celui que Google demande aux recruteurs). Sites visités : ceux des employeurs rencontrés dans les offres collectées (site de l'entreprise, page de candidature hébergée chez elle, sous-domaines `recrutement.`, `jobs.`…) et `CAREER_SITES` (liste manuelle). Robot identifié (`KareerBot`) et poli : robots.txt respecté pour chaque sous-domaine, délai demandé par le site (10 s au plus, 1,5 s au minimum), une requête à la fois, 150 pages d'offres par site au plus, aucune connexion, aucun contournement de protection (site protégé : ignoré). Offres hors de France ou expirées écartées ; offres retirées du site désactivées. Chaque site est revisité après 24 h (une semaine s'il n'a rien publié). Les pages carrière Greenhouse, Lever, Ashby ou SmartRecruiters repérées sur ces sites sont relues par la recherche de l'agent. `INGEST_SITES_PER_RUN` (40 par défaut) sites visités par heure (`INGEST_SITES_EVERY_MINUTES`).
- `npm run ingest:sites -- --test exemple.fr,recrutement.autre.fr` : essai sans base (offres trouvées sur ces sites) ; `npm run ingest:sites [-- --max 200]` : collecte manuelle. `DEBUG_CRAWL=1` affiche chaque page demandée.
- **Recherche depuis la base** (`JOBS_INDEX=on`, serveur web et worker) : la partie France Travail de chaque recherche est lue dans la base (instantané, sans quota) : plein texte en français, rayon autour de la commune ou département, contrat, puis codes métier ROME si aucun mot ne correspond. Les offres des sites d'employeurs s'y ajoutent (source « Sites carrière »). Les autres sources restent interrogées en direct. Base vide, pas à jour depuis 3 jours ou en panne : retour automatique à l'API.
- `npm run measure:channels` : **mesure en lecture seule** de la répartition des canaux de candidature (échantillon en direct de l'API France Travail, ou `-- --db` sur la base) : part déjà envoyable automatiquement, logiciels de recrutement à connecter ensuite (par volume), sites inconnus, partenaires d'origine. `-- --json rapport.json` pour le détail.

## Mise en production

- **Docker** : `docker build -t autopostule --build-arg VITE_SUPABASE_URL=… --build-arg VITE_SUPABASE_ANON_KEY=… .` puis `docker run -p 3000:3000 --env-file .env autopostule` (Chromium inclus pour les PDF). Compatible Render, Railway, Fly.io, Cloud Run, Scaleway.
- **Suivi des erreurs** : `SENTRY_DSN` (serveur) et `VITE_SENTRY_DSN` (navigateur) ; les corps de requête (CV, profils) ne sont jamais envoyés.
- **Mesure d'usage** : `VITE_POSTHOG_KEY` (PostHog UE, sans cookie, sans enregistrement de session) ; évènements : recherche, offre sauvegardée, candidature express, dossier validé, inscription, page Tarifs, quota atteint, paiement commencé.

## Autres variables

| Variable | Rôle |
|---|---|
| `GEMINI_API_KEY` | IA (analyse du CV, CV et lettre sur mesure, kit d'entretien). Sans clé : modèles standards. |
| `AUTH_MODE` | `off`, `optional` (défaut) ou `required` : vérification des comptes (jeton Supabase) côté serveur |
| `PORT` | Port d'écoute |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Facultatif : cache, limite de débit et quotas partagés entre plusieurs serveurs (Redis Upstash) |
| `PDF_CONCURRENCY` | Nombre maximal de PDF Web générés en parallèle (3 par défaut) |
| `LATEX_COMPILER` | `tectonic`, `pdflatex` ou `off` pour le bouton « Télécharger le PDF » |

## Fonctionnalités

- **Offres** : recherche quoi / où / rayon, filtres (contrat, télétravail, date, source, type, compatibilité), tri, fiche détaillée avec carte, liens vers les autres plateformes et fiche entreprise.
- **Alertes** : enregistrez une recherche ; les nouvelles offres sont comptées à chaque ouverture (notifications du navigateur en option).
- **Liens partageables** : l'onglet, la recherche et l'offre ouverte sont dans l'URL ; Précédent / Suivant fonctionnent.
- **Profil** : import du CV en PDF, Word (.docx), image ou texte ; rien n'est inventé.
- **Assistant** : choisit les meilleures offres selon vos critères (compatibilité, contrats), prépare CV + lettre un par un ou en série (3, 5, 10), charge les pages suivantes des sources si besoin et explique les offres écartées. File « Dossiers prêts à envoyer » : ouverture du portail, lettre copiée, CV en PDF téléchargé. Rien n'est envoyé à votre place.
- **Studio CV** : CV LaTeX en 3 modèles, PDF, lettre ; les versions précédentes sont conservées (onglet Historique).
- **Candidatures** : suivi en 6 étapes, relances à J+7 avec rappel calendrier (.ics), statistiques (taux de réponse, délai, efficacité par source), export Excel (CSV) et sauvegarde / restauration JSON.
- **Entretiens** : synthèse, pitch, questions probables, entraînement avec évaluation STAR.
- **Accessibilité et confort** : navigation au clavier, fenêtres accessibles (focus, Échap), lien d'évitement, mode sombre (automatique ou manuel).
- **Suivi des erreurs** : les erreurs du navigateur sont envoyées à `/api/client-errors` et journalisées en JSON avec les événements du serveur.
