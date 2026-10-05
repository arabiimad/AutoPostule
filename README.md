# AutoPostule

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
npm run build             # interface (dist/) + serveur (dist/server.cjs)
npm start                 # sert dist/ ; port = variable PORT (3000 par défaut)
```

## Mettre en ligne

L'application est un serveur Node unique (interface + API). Elle a besoin d'un serveur **toujours allumé** : le robot des sites carrières indexe les offres en tâche de fond. Un `Dockerfile` est fourni ; il inclut Chromium pour l'export PDF.

### Render (le plus simple, depuis GitHub)
1. Fusionner les changements dans `main` sur GitHub.
2. Sur https://render.com : **New → Blueprint**, puis choisir ce dépôt. Le fichier `render.yaml` crée le service, avec un disque de 1 Go pour l'index des sites carrières.
3. Renseigner les clés demandées (toutes facultatives : `GEMINI_API_KEY`, `FT_CLIENT_ID`…), puis valider.
4. L'adresse publique s'affiche (`https://autopostule-xxxx.onrender.com`). Au premier démarrage, les sites carrières se remplissent en 5 minutes environ.

Plan `starter` (environ 7 $/mois + 0,25 $/mois pour le disque). Le plan gratuit fonctionne aussi (`plan: free`, sans la section `disk`), mais il s'endort après 15 minutes sans visite : l'index repart de zéro à chaque réveil.

### Autres hébergeurs (Railway, Fly.io, Cloud Run, VPS…)
N'importe quel hébergeur de conteneurs Docker convient :
```bash
docker build -t autopostule .
docker run -p 3000:3000 -v autopostule-cache:/app/.cache --env-file .env autopostule
```
- Port : variable `PORT` (3000 par défaut).
- Disque persistant facultatif sur `/app/.cache`.
- Cloud Run : `--min-instances=1 --no-cpu-throttling`, pour que le robot tourne entre deux visites.

Après le déploiement, pensez à ajouter le domaine de l'application dans Firebase (Authentication → Paramètres → Domaines autorisés) pour que la connexion fonctionne.

## Scripts

| Commande | Rôle |
|---|---|
| `npm run dev` | Serveur + interface avec rechargement (Vite) |
| `npm run build` / `npm start` | Construction puis lancement en production |
| `npm run lint` | Vérification des types TypeScript |
| `npm test` | Tests unitaires (sources, fusion des doublons, score, LaTeX, statistiques, import Word…) |
| `npm run test:e2e` | Parcours complet dans un vrai navigateur, sources simulées (après `npm run build` et `npx playwright install chromium`) |
| `npm run check:sources -- "développeur web" Lyon alternance` | Teste vos vraies clés d'API : offres par source, erreurs, avertissements |
| `npm run discover:sites` | Cherche les sites carrières des entreprises françaises et met à jour l'annuaire (long : plusieurs dizaines de minutes la première fois) |
| `npm run check:ai` | Teste la clé Gemini (modèles accessibles) et la génération d'un CV d'exemple |
| `npm run deploy:rules` | Déploie les règles Firestore |

Intégration continue : déplacez `ci/github-ci.yml` vers `.github/workflows/ci.yml` (types, tests, build et tests de bout en bout à chaque push sur GitHub).

## Sources d'offres (.env)

| Source | Contenu | Variables |
|---|---|---|
| France Travail | Offres d'emploi (CDI, CDD, alternance…) | `FT_CLIENT_ID`, `FT_CLIENT_SECRET` |
| La bonne alternance | Offres en alternance + entreprises qui recrutent sans offre publiée (candidatures spontanées) | `LBA_API_KEY` |
| JSearch (Google for Jobs) | Offres publiées sur LinkedIn, Indeed, Welcome to the Jungle, Glassdoor… | `JSEARCH_API_KEY` |
| Adzuna | Agrégateur | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` |
| Sites carrières | Offres publiées directement par les entreprises sur leur logiciel de recrutement (Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee, Teamtailor, Workday) : Doctolib, Qonto, Alan, Airbus, Thales, Sanofi, Ubisoft, ALTEN… | Aucune clé ; `ATS_SOURCES=off` pour désactiver, `ATS_COMPANIES_FILE` pour ajouter des entreprises |
| Jooble | Agrégateur | `JOOBLE_API_KEY` (+ `JOOBLE_HOST=https://fr.jooble.org` pour une clé française) |

Sans aucune clé, seuls les sites carrières sont interrogés (vraies offres). Avec `ATS_SOURCES=off` et aucune clé, l'application fonctionne en mode démonstration (offres indicatives).

Sites carrières : un robot parcourt en tâche de fond tous les sites de l'annuaire via l'API publique de leur logiciel de recrutement. Il garde les offres en France dans un index en mémoire, sauvegardé dans `.cache/career-index.json` pour que le serveur redémarre avec ses offres. Chaque site est mis à jour toutes les 3 h, et la recherche filtre l'index sans appel externe. Au tout premier démarrage, l'index se remplit en quelques minutes : les premières recherches affichent un avertissement en attendant. « Postuler » mène toujours à la page officielle de l'offre.

L'annuaire a deux parties :
- `server/data/careerSites.generated.ts` est produit par `npm run discover:sites`. Le script liste les entreprises françaises (API publique Recherche d'entreprises : grandes entreprises, ETI, PME du numérique et du conseil, plus des marques connues), essaie leurs identifiants sur Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee et Teamtailor, et ne garde que les sites qui ont des offres en France. Il est à relancer de temps en temps ; les réponses sont mises en cache dans `.cache/career-sites/`.
- `server/careerSitesDirectory.ts` contient les entrées vérifiées à la main, dont les sites Workday, qui ne se devinent pas.

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
4. **Mise en forme** : modèles LaTeX Classique, Moderne, Compact → le PDF compile toujours.

Dans le Studio : onglet **Contenu** (retouche de chaque puce par l'IA avec des consignes, réordonnancement, masquage), **Aperçu** PDF intégré, changement de modèle sans perdre le contenu. `npm run check:ai` teste votre clé et affiche un CV adapté d'exemple.

Modèle Pro : l'abonnement Google AI Pro (application Gemini) ne donne pas accès à l'API. Pour utiliser `gemini-3.1-pro-preview` via l'API, activez la facturation du projet Google Cloud lié à la clé (environ 2 $ / 12 $ par million de jetons en entrée / sortie, soit quelques centimes par CV). Sans facturation, l'application passe automatiquement sur Flash.

## Autres variables

| Variable | Rôle |
|---|---|
| `GEMINI_API_KEY` | IA (analyse du CV, CV et lettre sur mesure, kit d'entretien). Sans clé : modèles standards. |
| `AUTH_MODE` | `off`, `optional` (défaut) ou `required` : vérification des comptes Firebase côté serveur |
| `PORT` | Port d'écoute |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Facultatif : cache, limite de débit et quotas partagés entre plusieurs serveurs (Redis Upstash) |
| `LATEX_COMPILER` | `tectonic`, `pdflatex` ou `off` pour le bouton « Télécharger le PDF » |

## Fonctionnalités

- **Offres** : recherche quoi / où / rayon, filtres (contrat, télétravail, date, source, type, compatibilité), tri, fiche détaillée avec carte, liens vers les autres plateformes et fiche entreprise.
- **Alertes** : enregistrez une recherche ; les nouvelles offres sont comptées à chaque ouverture (notifications du navigateur en option).
- **Liens partageables** : l'onglet, la recherche et l'offre ouverte sont dans l'URL ; Précédent / Suivant fonctionnent.
- **Profil** : import du CV en PDF, Word (.docx), image ou texte ; rien n'est inventé.
- **Studio CV** : CV LaTeX en 3 modèles, PDF, lettre ; les versions précédentes sont conservées (onglet Historique).
- **Candidatures** : suivi en 6 étapes, relances à J+7 avec rappel calendrier (.ics), statistiques (taux de réponse, délai, efficacité par source), export Excel (CSV) et sauvegarde / restauration JSON.
- **Entretiens** : synthèse, pitch, questions probables, entraînement avec évaluation STAR.
- **Accessibilité et confort** : navigation au clavier, fenêtres accessibles (focus, Échap), lien d'évitement, mode sombre (automatique ou manuel).
- **Suivi des erreurs** : les erreurs du navigateur sont envoyées à `/api/client-errors` et journalisées en JSON avec les événements du serveur.
