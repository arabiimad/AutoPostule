# Corrections de la logique — 23/09/2026

Les fichiers d'origine sont sauvegardés dans `_backup_avant_corrections/`.

## Données personnelles et contenu inventé
- Le profil de départ est vide (`EMPTY_PROFILE`). `IMADEDDINE_PROFILE` a été supprimé du code.
- Le Studio LaTeX, le serveur et les prompts n'utilisent plus aucune valeur de repli personnelle.
- Le CV de secours n'utilise que les données du profil : plus de permis, de certifications, de valeurs d'entreprise ni de bloc « Gestion de Projet IT » ajoutés en dur. Une section vide est omise.
- L'analyseur local n'invente plus rien : ni nom « Candidat », ni accroche, ni compétences ou formation par défaut. Chaque langue garde son propre niveau.
- `escapeLatex` échappe en une seule passe (le bug `\textbackslash\{\}` est corrigé), et les URL sont échappées dans `\href`.

## Erreurs visibles
- `/api/cv/analyze` renvoie une erreur 422 si le CV est illisible ou dans un format non pris en charge (.docx…). Avant, il renvoyait un faux succès.
- Firestore est configuré avec `ignoreUndefinedProperties`. Un échec de sauvegarde s'affiche maintenant à l'écran.
- `res.ok` est contrôlé partout. En cas d'erreur, le Studio n'affiche plus un faux 92 %.
- Le serveur indique quand il utilise un modèle standard au lieu de l'IA (`notice`).

## Score et recherche
- Un seul calcul de score (`utils/skillMatcher.ts`) : entre 0 et 100, sans plancher de 25 %. Il ignore les accents et reconnaît quelques synonymes. « Gestion » ne valide plus « Gestion prestataires ».
- Le curseur du Radar filtre sur le score calculé pour l'utilisateur, et les offres sont triées par compatibilité.
- La recherche exige TOUS les mots significatifs. « Remote » / « Télétravail » est reconnu comme localisation.
- Un seul lien de candidature par offre (`utils/jobLinks.ts`). Le portail « EY » ne s'applique plus à « Leroy… ».

## Parcours de candidature
- Le portail s'ouvre au moment du clic (plus de blocage des fenêtres), et le CV et la lettre sont générés en parallèle.
- Chaque offre n'a qu'un seul dossier (pas de doublon). Le Studio met à jour le dossier existant au lieu d'en créer un nouveau.
- « Voir le CV » réaffiche le CV et la lettre enregistrés.
- La description et les compétences de l'offre sont conservées dans la candidature. Le kit d'entretien les utilise, ainsi que le profil réel et les compétences manquantes, et il est sauvegardé.
- L'Assistant choisit la meilleure offre non traitée qui respecte le seuil ET les contrats préférés. Ses réglages sont enregistrés. Les textes de l'interface ne promettent plus d'envoi automatique.
- Le Kanban a une colonne « Refusées ». Le compteur de l'en-tête compte les candidatures réellement déposées.

## Comptes et stockage
- App est le seul composant qui crée le profil Firestore (plus d'écritures concurrentes avec AuthModal).
- Le `localStorage` est séparé par utilisateur. La déconnexion réinitialise tout. La session locale est restaurée au rechargement.
- Les règles Firestore vérifient `userId`, et `/jobs` est en lecture seule. Elles sont à redéployer : `firebase deploy --only firestore:rules`.

## Serveur
- Limite de 30 requêtes IA par minute et par IP, corps de requête limité à 12 Mo.
- Les modèles Gemini 1.5 (retirés) ont été supprimés. Un modèle introuvable (404) passe au suivant.
- Modèle préféré : `gemini-3.6-flash` (choix conservé), puis `gemini-2.5-flash` et `gemini-2.0-flash` en secours.

## Revérification (2e passe)
- Synonymes : correspondance exacte uniquement. Avant, « JavaScript » validait « Node.js » (à cause de « js »).
- Limiteur de débit : il utilise `req.ip` avec `trust proxy = 1` au lieu de l'en-tête X-Forwarded-For, que le client peut falsifier pour contourner la limite. La table est nettoyée régulièrement.
- Offres trouvées par recherche IA : leur identifiant est maintenant stable. Avant, un nouvel id à chaque recherche permettait de créer un dossier en double.
- Anti-doublon : une offre est aussi reconnue par entreprise + intitulé, et « Générer CV LaTeX » rouvre le dossier existant.
- Inscription par email : le nom et le titre saisis ne peuvent plus être écrasés par une valeur vide, quel que soit l'ordre des événements Firebase.
- Mode invité : le profil est rechargé après un rafraîchissement, et les données locales s'affichent sans attendre Firebase.
- Lien de candidature : le portail carrières officiel passe avant une simple page de recherche Indeed/Google.
- Onglet Studio : il affiche les 60 offres les plus compatibles au lieu de 808 cartes.

---

# Nouveautés — vraies offres, sécurité, PDF, relances

## Mise en route
1. `npm install` : ajoute `firebase-admin`, nécessaire pour vérifier les comptes côté serveur.
2. Dans `.env`, ajoute les clés voulues (voir `.env.example`) :
   - `LBA_API_KEY` : une clé créée sur https://api.apprentissage.beta.gouv.fr/fr/compte/profil. Commence par une clé « sandbox », puis passe à une clé « production ». L'usage est gratuit et non commercial.
   - `FT_CLIENT_ID` / `FT_CLIENT_SECRET` : crée une application sur https://francetravail.io et active l'API « Offres d'emploi v2 ».
   - Sans aucune clé, l'application reste en **mode démonstration** (base indicative), et l'interface l'indique clairement.
3. `npm test` : 32 tests automatiques.
4. `npm run dev`, puis `npm run deploy:rules` si ce n'est pas déjà fait.

## 1. Offres réelles (`server/jobSources.ts`)
- **La bonne alternance** : offres d'alternance issues de LBA, de France Travail et de leurs partenaires. La recherche se fait autour d'une ville (rayon réglable de 10 à 200 km) ou par département, avec un ciblage par code ROME quand la recherche le permet.
- **France Travail** : CDI, CDD, intérim, libéral et alternance. Le jeton OAuth est mis en cache. Les stages ne sont pas couverts par cette API, et l'interface le signale.
- **Lieux** : les villes sont converties en coordonnées via geo.api.gouv.fr. Tu peux aussi taper un numéro de département (« 84 ») ou « Remote ».
- **Doublons et tri** : les offres en double sont retirées (la fiche France Travail est conservée), puis triées par date. Les résultats sont gardés en cache 10 minutes.
- **Score sur les vraies offres** : les compétences sont repérées dans le texte de l'annonce. Les « savoir-être » (« Travailler en équipe »…) ne comptent pas.
- **Radar** : bandeau réel / démo, nombre d'offres par source, avertissements, badge de source et date d'expiration. En mode réel, les raccourcis métiers et le choix du contrat relancent une vraie recherche.
- **Correction** : la touche Entrée lance enfin la recherche. Avant, le formulaire n'avait pas de bouton de validation, donc Entrée ne faisait rien.

## 2. Sécurité et allègement
- **Vérification des comptes (`server/auth.ts`)** : le serveur vérifie le jeton Firebase de l'utilisateur, avec seulement l'identifiant du projet (pas de compte de service). `AUTH_MODE=required` réserve les fonctions IA aux comptes connectés. La limite de requêtes se fait par compte quand l'utilisateur est connecté.
- **Envoi du jeton** : toutes les requêtes de l'interface passent par `utils/api.ts`, qui ajoute le jeton automatiquement.
- **Allègement** : les 808 offres de démonstration ne sont plus incluses dans l'interface. Le fichier chargé par le navigateur passe de 2,08 Mo à 0,94 Mo.

## 3. PDF, modèles et relances
- **Trois vrais modèles de CV** : Classique (article), Moderne (moderncv) et Compact (une page). Changer de modèle régénère le CV. Le choix est mémorisé dans le profil et dans le dossier. Les trois compilent avec TeX Live (testé).
- **« Télécharger le PDF »** : compilation sur le serveur si `tectonic` ou `pdflatex` est installé (MiKTeX ou TeX Live sous Windows), sinon Overleaf reste proposé. Par sécurité, les commandes shell et d'accès aux fichiers sont refusées, TeX tourne en mode restreint et chaque compilation est limitée à 45 s.
- **Relances** : en passant une candidature en « Déposée », une relance est programmée à J+7. La carte affiche « À relancer » et l'en-tête le nombre de relances dues. La fenêtre de relance propose un brouillon d'email (IA ou modèle), à copier ou ouvrir dans ta messagerie. Chaque relance envoyée reprogramme la suivante à J+7, avec 3 relances au maximum.

## Tests (`tests/`)
Calcul de score, filtre d'offres, liens, analyseur de CV, LaTeX (échappement, 3 modèles, commandes interdites, compilation réelle), sources d'offres (normalisation, géocodage, recherche combinée avec simulations, jeton, pannes) et vérification des comptes.

---

# Plus de sources + refonte de l'interface

## Nouvelles sources (`server/jobSources.ts`)
| Source | Ce qu'elle apporte | Clé (.env) |
|---|---|---|
| JSearch (Google for Jobs) | Offres publiées sur **LinkedIn, Indeed, Welcome to the Jungle, Glassdoor**…, avec description complète et liens de candidature par plateforme | `JSEARCH_API_KEY` (≈ 200 requêtes/mois gratuites, cache de 6 h) |
| Adzuna | Agrégateur (extrait de l'annonce + lien) | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` |
| Jooble | Agrégateur (Indeed, HelloWork…), extrait + lien | `JOOBLE_API_KEY` (500 requêtes par clé, cache de 12 h) |

- LinkedIn, Indeed et WTTJ n'ont pas d'API publique pour lire leurs offres, et les « scraper » est interdit par leurs conditions d'utilisation. Ces offres passent donc par Google for Jobs (JSearch), qui les indexe légalement.
- Pour économiser leurs quotas, JSearch et Jooble ne sont interrogés que pour une recherche avec mot-clé.
- **Fusion des doublons** : si la même offre est trouvée sur plusieurs plateformes, elle n'apparaît qu'une fois. La fiche la plus complète est gardée, et la section « Postuler aussi via » liste les autres plateformes.
- **Contrat et télétravail déduits prudemment** : seulement quand le texte de l'annonce les mentionne ; sinon ils restent « non précisé ».

## Fiche détaillée d'une offre
Sur ordinateur, la liste est à gauche et la fiche complète à droite. Sur mobile, la fiche s'ouvre en plein écran. La fiche contient :
- l'en-tête : entreprise, contrat, lieu, télétravail, salaire, date de publication, date d'expiration et source ;
- les actions : **Postuler sur [plateforme]**, **Préparer CV + lettre**, **Sauvegarder**, **Candidature express** et **Copier le lien** ;
- la compatibilité : un score circulaire, les compétences présentes et absentes de ton profil ;
- le descriptif complet, avec un lien vers l'annonce d'origine quand la source ne fournit qu'un extrait ;
- la localisation : carte OpenStreetMap et itinéraire Google Maps depuis ta ville.

## Transports
Le bouton « Transports », présent sur toutes les offres, affichait des estimations inventées par l'IA (et, en démo, les mêmes textes partout). Il est supprimé, ainsi que la route serveur correspondante. Il est remplacé par la carte et l'itinéraire réels dans la fiche.

## Interface
- **Charte commune** : thème clair, police Inter, couleur de marque unique, composants partagés (`src/components/ui.tsx`).
- **En-tête** : navigation avec onglet actif souligné, compteur de relances et menu de compte. Sur mobile, les onglets passent dans une barre en bas de l'écran.
- **Page Offres** : grande barre de recherche (quoi, où, rayon) et filtres (contrat, télétravail, date, source, compatibilité). Tri par pertinence, date ou compatibilité. Squelettes pendant le chargement, états vides, « Afficher plus », navigation au clavier avec ↑ et ↓.
- **Sauvegarder une offre** : elle apparaît dans la colonne « Sauvegardées » du suivi, puis elle est complétée quand tu prépares le dossier (pas de doublon).
- **Candidatures** :
  - chiffres clés en haut (suivies, envoyées, entretiens, à relancer) ;
  - tableau en colonnes sur ordinateur, une étape à la fois sur mobile ;
  - une action principale par étape : Préparer, Postuler sur le site, J'ai postulé, Relancer, Préparer l'entretien ;
  - changement d'étape par liste déroulante et suppression en deux clics.
- **Entretiens, Assistant, Studio CV, Profil** : même mise en page claire.
- **Messages de notification** : lisibles, avec un bouton pour les fermer.

## Tests
38 tests automatiques, dont les nouvelles sources, la fusion des doublons et les déductions de contrat et de télétravail. Parcours complet vérifié dans le navigateur, sur ordinateur et sur mobile.

---

# État des lieux traité (23/09/2026)

## Sources testées avec les vraies clés
Tests réels (Avignon, Paris, Marseille) avec les 5 clés du `.env`. Corrections faites à partir des réponses réelles :
- **La bonne alternance** renvoie aussi des « recruteurs » (entreprises qui recrutent en alternance sans offre publiée) : ils sont maintenant proposés comme **candidatures spontanées** (badge, filtre « Type », fiche entreprise, lettre spontanée). À Avignon, pour « chef de projet informatique », c'est la seule source qui renvoie des résultats en alternance (40 entreprises).
- **Codes ROME dynamiques** : service de correspondance métier de La bonne alternance (mis en cache 24 h), avec repli sur la table locale.
- **France Travail** : mots-clés tous obligatoires, donc sans résultat on relance par codes ROME. Correction des caractères mal encodés (« Alternance \x96 Ingénieur »). Les offres « Entreprise non communiquée » ne sont plus fusionnées à tort entre elles (une même source ne peut pas être son propre doublon).
- **Adzuna** : mots vides retirés (« de », « en ») ; relance sans « alternance » si aucun résultat ; le contrat indiqué dans l'intitulé prime sur le texte.
- **Jooble** : la clé est internationale (jooble.org) ; « Paris » renvoyait Paris (Texas). Lieu envoyé avec « , France », lieux étrangers et offres hors sujet écartés, avertissement si tout est écarté (recommandation : clé fr.jooble.org + `JOOBLE_HOST`).
- **Google Jobs (JSearch)** : réponses souvent > 10 s. Attente limitée à 12 s ; la requête continue en arrière-plan et remplit le cache pour la recherche suivante.
- **Extraction des compétences** : faux positifs supprimés (« C'est » → C/C++, « en vue de » → Vue.js, « transport » → logistique, « Sage-femme » → Sage…) grâce à des sigles sensibles à la casse.
- `npm run check:sources` : vérifie vos clés avec une vraie recherche.

## Corrections
- Port configurable (`PORT`), `npm start` sert bien la version de production.
- Build compatible Windows / Linux / macOS (`scripts/build-server.mjs`, API d'esbuild) ; Vite n'est chargé qu'en développement.
- Suppression de `verifyFirestoreConnection` (erreur de permission inutile au démarrage).
- Score non évaluable enregistré `null` (et non 0).
- Base de démonstration : dates recalculées à chaque requête.

## Interface
- Fenêtres LaTeX, Entretien, Relance, Connexion, Import CV, pages Profil et Assistant : thème clair unifié, composant `Modal` accessible (focus piégé, Échap, retour du focus).
- **URL** : onglet, recherche et offre ouverte ; Précédent / Suivant ; bouton « Partager » d'une offre.
- **Mode sombre** (automatique ou manuel, bouton dans l'en-tête), sans flash au chargement.
- **Accessibilité** : lien « Aller au contenu », libellés, rôles ARIA (onglets, dialogues, alertes).
- **Premiers pas** : guide en 3 étapes au premier lancement.

## Fonctionnalités
- **Alertes** : recherches enregistrées (10 max), nouvelles offres comptées à l'ouverture (pastille sur l'onglet Offres), notifications du navigateur en option.
- **Pagination serveur** : « Charger plus d'offres depuis les sources ».
- **Historique des versions** du CV et de la lettre (10 par dossier), restauration et téléchargement .tex.
- **Import de CV Word (.docx)**, sans dépendance supplémentaire.
- **Relances** : rappel calendrier .ics (Outlook, Google Agenda) + notification quotidienne.
- **Statistiques** : taux de réponse, taux d'entretien, délai médian, efficacité par source, envois par semaine.
- **Export** Excel (CSV) et sauvegarde / restauration complète (JSON).
- **Fiche entreprise** : secteur, effectif, site web, fiche officielle (annuaire-entreprises.data.gouv.fr), LinkedIn.

## Technique
- `server/store.ts` : cache, limite de débit et compteurs de quotas en mémoire, ou partagés via Redis Upstash (`UPSTASH_REDIS_REST_URL/TOKEN`).
- Avertissement quand un quota gratuit atteint 80 %.
- Journal JSON structuré (recherches, erreurs) et remontée des erreurs du navigateur (`/api/client-errors`).
- CI GitHub Actions ; tests de bout en bout dans le dépôt (`e2e/`, 29 vérifications) ; 48 tests unitaires.


---

# Génération du CV en chaîne (qualité « Gemini ») — 24/09/2026

Avant : un seul appel demandait à l'IA d'adapter le CV **et** d'écrire tout le LaTeX (compilation fragile, mise en page variable, contrôle impossible).

Maintenant (`server/cvPipeline.ts`) :
1. **Analyse de l'offre** en JSON (modèle rapide, cache 7 jours, partagée avec la lettre).
2. **Adaptation du contenu** en JSON par le modèle le plus puissant (`GEMINI_MODEL_BEST`, par défaut `gemini-3.1-pro-preview`).
3. **Garde-fous** : chiffres, outils et compétences exigées absents du profil → la proposition est écartée et le texte d'origine conservé (message affiché).
4. **Mise en forme** par les modèles LaTeX existants : compile toujours ; changer de modèle ne relance pas l'IA.

Studio : onglet **Contenu** (titre, accroche, puces éditables, « Retoucher » avec consignes, ordre et masquage des expériences et compétences), onglet **Aperçu** (PDF compilé intégré), **Analyse de l'offre** (exigences, missions, atouts). Le contenu est enregistré avec le dossier (retouches ultérieures sans nouvel appel IA).

Nouvelles routes : `/api/tailor/render` (mise en forme instantanée), `/api/tailor/rewrite` (retouche ciblée). `npm run check:ai`.

Testé avec votre clé : le modèle Pro répond « quota dépassé » (facturation requise ; l'abonnement Google AI Pro ne couvre pas l'API) → repli automatique sur Flash ; `gemini-3.8-flash` était momentanément surchargé → repli sur `gemini-3.6-flash` / `gemini-3.5-flash`. Tests : 55 unitaires, 36 vérifications de bout en bout (faux Gemini inclus).
