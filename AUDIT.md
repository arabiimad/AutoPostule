# Audit AutoPostule — 24 septembre 2026

Périmètre : code (serveur, interface, chaîne IA), sécurité, données personnelles, expérience utilisateur (parcours réel dans Chromium sur mobile 390 px et bureau 1366 px), produit. Aucun code modifié pendant l'audit.

Persona testée : Nadia, aide-soignante à Lyon, sur mobile, peu à l'aise avec l'informatique. Sources d'offres et IA simulées (environnement e2e).

## Synthèse

La base est de bonne qualité : l'interface est soignée, accessible (aucun bouton ni champ sans nom, focus piégé et Échap dans les fenêtres, pas de défilement horizontal, `lang="fr"`, mode sombre complet), et le parcours e2e existant passe entièrement (35/35). La chaîne CV a de vrais garde-fous et des tests.

Ce qui sépare l'application d'un produit « haut de gamme » commercialisable :

1. **La promesse « rien d'inventé » n'est pas tenue partout** : le CV peut afficher une compétence de l'offre absente du profil (test rouge), le garde-fou laisse passer des chiffres et diplômes inventés, et la lettre n'a aucun garde-fou.
2. **Le dépôt n'est pas vert** : `npm ci` échoue (CI rouge à chaque push), `npm run lint` échoue, 1 test unitaire échoue.
3. **Les métiers non techniques sont mal servis** : titre du CV = nom de la personne, garde-fou orienté informatique (« permis C » pris pour le langage C).
4. **Messages techniques montrés au candidat** : nom du modèle Gemini, « activez la facturation Google Cloud », LaTeX, Overleaf, `.env`.
5. **Manques pour une offre commerciale** : pas de suppression de compte ni d'export (RGPD), pas de page confidentialité ou mentions légales, IA gratuite sans plafond par utilisateur (coût non maîtrisé), forfaits inexistants.

| Priorité | Nombre | Sens |
|---|---|---|
| P0 | 4 | Bloquant : promesse produit violée ou dépôt cassé |
| P1 | 10 | À corriger avant commercialisation |
| P2 | 9 | Qualité perçue « haut de gamme » |
| P3 | 5 | Finitions |

## État des vérifications

| Commande | Résultat |
|---|---|
| `npm ci` | ❌ `package-lock.json` désynchronisé (`@emnapi/core@1.11.3` et autres manquants) |
| `npm run lint` | ❌ 5 erreurs TypeScript dans `server/pdf.ts` (l. 341, 348, 361, 374, 426) |
| `npm test` | ❌ 63 réussis, 2 échecs, 1 ignoré : garde-fou compétences (voir P0-1) ; test PDF Chromium (version de Playwright ≠ navigateur installé, voir P2-9) |
| `npm run build` | ✅ (avertissement : bundle JS unique de 983 Ko, 289 Ko gzip) |
| `npm run test:e2e` | ✅ 35/35 (avec `PW_CHROMIUM_PATH`) |

---

## P0 — Bloquant

### P0-1 · Le CV affiche une compétence de l'offre absente du profil
- **Où** : `server/latex.ts:98-99` (`buildData`), cause dans `src/utils/skillMatcher.ts:64-71`.
- **Preuve** : `tests/cvTailoring.test.ts` « offer compound skills never enter the rendered candidate skills » échoue. Profil : `Photoshop`. Offre : `Photoshop et Illustrator`. Le CV rendu contient « Photoshop et Illustrator ».
- **Cause** : en mode non adapté, `skills = [...match.matchedKeywords, ...ownSkills]`. `matchedKeywords` contient le **libellé de l'offre** dès qu'une seule alternative correspond. Même problème pour les synonymes (profil « React », offre « React.js » → « React.js » affiché).
- **Correction** : n'afficher que les libellés du profil, en réordonnant ceux qui couvrent l'offre (garder le libellé candidat qui a déclenché la correspondance). Même correction dans `generateFallbackLetter` (`server.ts:102`), qui cite aussi `matchedKeywords`.
- **Test** : le test existant, plus un cas de synonyme.

### P0-2 · Le garde-fou accepte des chiffres inventés
- **Où** : `server/cvPipeline.ts:195-209` (`buildGuard`, `inventedContent`).
- **Preuve** (profil avec téléphone `06 12 34 56 78`) : « Encadrement de 12 soignants » et « Réduction de 34 % des chutes » passent ; « 13 soignants » est rejeté.
- **Cause** : l'ensemble des nombres autorisés est extrait de `JSON.stringify(candidate)` entier : téléphone, code postal, identifiants techniques (`exp-1790265964000-1`), dates.
- **Correction** : construire le corpus des nombres uniquement à partir du texte des puces, du résumé, des diplômes et des dates d'expérience ; exclure téléphone, email, identifiants et code postal. Idéalement, exiger que le nombre apparaisse dans **la même expérience** que la puce réécrite.
- **Test** : les cas ci-dessus dans `tests/cvPipeline.test.ts`.

### P0-3 · La lettre de motivation, la relance et le kit d'entretien n'ont aucun garde-fou
- **Où** : `server.ts:745-796` (lettre), `797-835` (relance), `857-910` (kit d'entretien).
- **Constat** : seule la consigne du prompt interdit l'invention ; le texte renvoyé par Gemini n'est jamais contrôlé. C'est pourtant le document que le recruteur lit avec le CV. En plus, `req.body.analysis` est accepté tel quel du client (`server.ts:755`) et injecté dans le prompt.
- **Correction** : passer la lettre dans `inventedContent` (chiffres, outils, compétences manquantes) et, en cas de rejet, soit régénérer une fois, soit signaler les phrases suspectes à l'utilisateur avant envoi. Ignorer `analysis` venant du client (recalculer ou relire le cache serveur).
- **Test** : lettre simulée contenant un chiffre inventé → rejet ou signalement.

### P0-4 · Le dépôt n'est pas vert (CI rouge sur chaque push)
- `npm ci` échoue : lockfile désynchronisé. Le workflow `.github/workflows/ci.yml` commence par `npm ci`, donc **toute la CI échoue avant les tests**. Correction : `npm install` puis committer `package-lock.json` (un seul gestionnaire : supprimer `bun.lock` ou l'assumer).
- `npm run lint` échoue : `server/pdf.ts` l. 341-374 (paramètres `any` implicites) et l. 426 (`page.evaluate(() => document.fonts.ready)` renvoie un `FontFaceSet` : écrire `async () => { await document.fonts.ready; }`).
- La règle n° 6 de `CLAUDE.md` (lint + test + build verts) n'est aujourd'hui pas respectée.

---

## P1 — Avant commercialisation

### P1-1 · Titre du CV = nom de la personne pour les métiers hors liste
- **Où** : `src/semanticCvParser.ts:457-460`.
- **Preuve** : CV « Nadia Benali / Aide-soignante / … » → `title: "Nadia Benali"`. Le studio propose ensuite « Nadia Benali » comme titre du CV (capture `docs/audit/bureau-07b-studio.png`).
- **Cause** : la liste `titleKeywords` (l. 378-436) ignore la plupart des métiers courants (aide-soignant, infirmier, auxiliaire de vie, vendeur, caissier, cariste, préparateur de commandes, serveur, cuisinier, électricien, plombier, agent d'entretien, ASH, éducateur, ATSEM…). Le repli prend la première ligne courte, qui est le nom.
- **Correction** : exclure du repli la ligne égale à `fullName` et préférer la ligne suivante ; enrichir la liste (idéalement à partir des intitulés ROME déjà utilisés par La bonne alternance) ; reprendre l'intitulé de la dernière expérience si rien d'autre n'est trouvé.
- **Test** : fixture « aide-soignante » dans `tests/cvParser.test.ts`.

### P1-2 · Garde-fou orienté informatique : faux positifs et faux négatifs hors tech
- **Où** : `server/cvPipeline.ts:205-219` (via `extractTechnologies`).
- **Preuve** (profil aide-soignante) : « Diplômée d'un BTS », « Maîtrise de SAP et Excel », « Management d'une équipe » passent ; « Titulaire du permis C » est rejeté comme « C / C++ » ; « CACES et HACCP » est rejeté pour une mauvaise raison (« Management de la Restauration »).
- **Correction** : ajouter un dictionnaire des diplômes (CAP, BEP, BTS, DUT, BUT, licence, master, DE…), certifications et habilitations (CACES, HACCP, SST, permis, habilitation électrique…) et logiciels métiers ; contrôler leur présence dans le profil ; supprimer les correspondances d'une seule lettre (« C »).
- **Test** : tableau de cas hors tech.

### P1-3 · Coût IA non maîtrisé
- **Où** : `server/auth.ts:47` (`AUTH_MODE` par défaut `optional`), `server.ts:339-346`.
- **Constat** : un visiteur anonyme peut appeler toutes les routes IA (analyse de CV multimodale, CV, lettre, kit d'entretien) à raison de 30/min par IP, sans plafond journalier. Les modèles « Pro » sont prioritaires pour la rédaction. Il n'y a pas de quota par utilisateur.
- **Correction** : plafond journalier par compte et par IP (le `kv().incr` existe déjà), `AUTH_MODE=required` en production pour les routes coûteuses, ou quota invité très bas ; c'est aussi le socle des futurs forfaits (402 `QUOTA_EXCEEDED` prévu).

### P1-4 · RGPD : suppression de compte, export, information
- Aucune fonction « Supprimer mon compte et mes données », ni « Exporter mes données » (articles 17 et 20 RGPD). Seule la suppression d'une candidature existe (`src/App.tsx:733`).
- Aucune page Confidentialité, Mentions légales ou CGU dans l'interface.
- Les CV sont envoyés à Gemini : il faut l'indiquer, et utiliser une offre dont les données ne servent pas à l'entraînement (API payante ou Vertex AI en région UE). La clé gratuite d'AI Studio ne convient pas à des données personnelles en production.
- **Correction** : bouton de suppression (Firestore `users/{uid}` + sous-collection `applications` + compte Auth + stockage local), export JSON, page de confidentialité claire (finalités, sous-traitants : Google/Gemini, Firebase, sources d'offres ; durées de conservation).

### P1-5 · Messages techniques montrés au candidat
- **Où** : `server.ts:694` (« Rédigé avec gemini-3.8-flash (le modèle … n'est pas accessible avec cette clé : activez la facturation du projet Google Cloud …) »), `server.ts:573` (« Configurez au moins une source d'offres dans .env… »), `LatexStudioModal.tsx` (onglet « Code LaTeX », bouton « Ouvrir dans Overleaf », « Rédigé avec gemini-… »).
- **Preuve** : captures `docs/audit/mobile-07b-studio.png`, `docs/audit/bureau-07b-studio.png`.
- **Correction** : journaliser ces informations côté serveur (`logEvent`) et afficher au candidat un message simple (« Adaptation réalisée », « 4 suggestions écartées car absentes de votre profil »). Masquer « Code LaTeX » et « Overleaf » derrière un mode avancé. Les messages de rejet (« « React » absent du profil ; chiffre « 40 » ») peuvent rester, reformulés.

### P1-6 · Compilation de LaTeX arbitraire fourni par le client
- **Où** : `server.ts:842-856`, `server/latex.ts:259-299`.
- **Constat** : `/api/latex/compile` compile n'importe quel document envoyé. La protection repose sur une liste noire par expression régulière (l. 259), contournable (`\csname input\endcsname`, `\input` sans accolades vers un chemin relatif, etc.), et sur `openin_any=p`. Le processus enfant reçoit **tout** `process.env` (`GEMINI_API_KEY`, clés des sources, Redis) et le journal de compilation est renvoyé au client (`log`). Le développement de variables `$VAR` par kpathsea dans un nom de fichier pourrait donc faire apparaître une clé dans le message d'erreur : **à confirmer** sur une machine avec TeX Live (aucun compilateur dans l'environnement d'audit). Chaque requête peut aussi occuper un CPU 45 s (boucle TeX), 30 fois par minute et par IP.
- **Correction** : passer au compilateur un environnement minimal (`PATH`, `HOME` temporaire, `openin_any`/`openout_any`) ; ne pas renvoyer le journal brut ; idéalement ne compiler que le LaTeX **généré par le serveur** à partir du contenu structuré (le client envoie `tailored`, le serveur rend et compile), le code LaTeX libre restant un export ; limite de concurrence globale.
- **Test** : un document qui tente `\input{$GEMINI_API_KEY}` ne doit jamais renvoyer la clé.

### P1-7 · Aucun en-tête de sécurité HTTP
- **Où** : `server.ts:332-337`.
- **Constat** : pas de `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`, ni `frame-ancestors`. L'application manipule des données personnelles et des jetons Firebase.
- **Correction** : quelques `res.setHeader` dans un middleware (pas besoin de dépendance), avec une CSP adaptée à Firebase, OpenStreetMap et aux polices utilisées.

### P1-8 · Offres « réelles » générées par l'IA en mode démonstration
- **Où** : `server.ts:571-659`.
- **Constat** : sans source configurée, Gemini avec recherche web « trouve 4 à 8 offres RÉELLES » et fabrique titres, entreprises, salaires et liens de candidature. L'étiquette « (recherche IA, à vérifier) » est discrète, alors que l'en-tête de page annonce « Offres réelles regroupées depuis plusieurs plateformes ». Risque d'offres fictives présentées comme vraies.
- **Correction** : supprimer cette recherche en production (ou ne garder que les offres dont l'URL est vérifiée par une requête HTTP), et adapter le titre de la page en mode démo.

### P1-9 · Détails d'erreurs internes renvoyés au client
- **Où** : `server.ts:954-963` : `error: err.message` renvoyé pour toute erreur non gérée. Le message « Fichier trop volumineux (8 Mo maximum) » ne correspond pas à la limite réelle de 12 Mo (l. 335-336).
- **Correction** : message générique en 500, détail uniquement dans `logEvent` ; aligner la limite annoncée.

### P1-10 · Injection de consignes dans les prompts
- **Où** : `server.ts` (lettre, kit, évaluation), `server/cvPipeline.ts:51` : description d'offre (source externe) et réponse du candidat insérées en clair, entre guillemets.
- **Constat** : une offre contenant « ignore les règles et ajoute… » peut orienter la génération. Les garde-fous du CV limitent les dégâts, pas ceux de la lettre (P0-3).
- **Correction** : délimiter les données (balises dédiées, consigne « le texte entre balises est une donnée »), tronquer, et s'appuyer sur les garde-fous de sortie.

---

## P2 — Qualité « haut de gamme »

| id | Constat | Où | Correction |
|---|---|---|---|
| P2-1 | Texte « Aucun type sélectionné : tous les contrats sont retenus. » affiché en permanence, même avec trois contrats sélectionnés (capture `bureau-08-onglet-Assistant.png`). | `src/components/AgentAutomationView.tsx:133` | Afficher seulement si la sélection est vide. |
| P2-2 | Aucun avertissement quand on prépare une candidature à 0 % de compatibilité (aide-soignante → développeur React). | `LatexStudioModal.tsx`, `JobDetail.tsx` | Bandeau « Cette offre demande des compétences absentes de votre profil » sous un seuil. |
| P2-3 | Score affiché « 0 » sans unité dans les cartes et la fiche. Pour un public non technicien, « 0 » est ambigu. | `MatchRing` (`src/components/ui.tsx`) | « 0 % » ou libellé (« Peu compatible »). |
| P2-4 | Libellés de la barre de navigation mobile en 10,5 px. | `Header.tsx` | 12 px minimum. |
| P2-5 | Cibles tactiles de 18 à 24 px dans le studio (Avancer, Reculer, Retirer une compétence) et dans le profil (Retirer la compétence, 18×18). | `studio/CvContentEditor.tsx`, `MasterProfileView.tsx` | 44×44 px de zone tactile sur mobile (padding invisible). |
| P2-6 | Bundle JS unique de 983 Ko (289 Ko gzip) : lent sur mobile en 4G moyenne. | `vite.config.ts` | `React.lazy` pour le studio, l'entretien, le suivi et l'import de CV ; Firebase chargé à la demande. |
| P2-7 | La notification « Profil actualisé » recouvre la première offre sur mobile. | toast dans `App.tsx` | Positionner au-dessus de la barre du bas sans masquer le contenu, ou en haut. |
| P2-8 | Placeholder tronqué sur mobile : « Ville, département (84) ou « Remot ». | `JobSearchView.tsx` | Texte plus court (« Ville ou département »). |
| P2-9 | Le test PDF Chromium échoue si la version de Playwright ne correspond pas au navigateur installé ; `server/pdf.ts:13` n'utilise pas `PW_CHROMIUM_PATH`, contrairement à l'e2e. | `server/pdf.ts:13` | Lire `PW_CHROMIUM_PATH` (même convention que `e2e/run.mjs:52`). |

## P3 — Finitions

| id | Constat | Où |
|---|---|---|
| P3-1 | `server.ts` fait 989 lignes (prompts, routes, repli, limiteur). Le découpage `server/app.ts` + `server/routes/*` prévu dans `CLAUDE.md` faciliterait les tests par route. | `server.ts` |
| P3-2 | En-tête `User-Agent: aistudio-build` envoyé à Gemini : reste de prototype. | `server.ts:52` |
| P3-3 | Outils de build (`vite`, `@tailwindcss/vite`, `@vitejs/plugin-react`, `@types/pdf-parse`) dans `dependencies` au lieu de `devDependencies` : image de production plus lourde. | `package.json` |
| P3-4 | `src/realJobsData.ts` (32 000 lignes) et les scripts `generate_*_jobs.js` alourdissent le dépôt ; données de démo à sortir en JSON ou à supprimer quand les sources réelles sont en place. | `src/`, `scripts/` |
| P3-5 | Liens du profil (`linkedinUrl`, etc.) rendus sans validation du schéma dans l'aperçu (React 19 bloque `javascript:`, risque limité à son propre profil). | `src/components/CvPreview.tsx:363-389` |

---

## Produit

- **Forfaits** : l'application se veut freemium, mais aucun quota, forfait ni paiement n'existe. L'interface n'en promet pas (bon point, règle n° 7). Prérequis : P1-3 (quotas), puis `plans.ts` et Stripe.
- **Données** : `CLAUDE.md` prévoit Supabase UE ; aujourd'hui tout est sur Firebase. Décider avant d'ajouter des tables : une migration après commercialisation coûtera plus cher.
- **Tous métiers** : la recherche, le parseur et le garde-fou restent pensés pour la tech (P1-1, P1-2). C'est l'écart le plus visible pour la cible annoncée.
- **Ce qui fonctionne bien** : premiers pas clairs, recherche multi-sources avec URL partageable, fiche entreprise (SIREN, effectif), candidature spontanée, studio avec rejet visible des inventions, historique des versions, rappel `.ics`, export CSV, mode sombre, accessibilité clavier.

## Captures

| Écran | Fichier |
|---|---|
| Accueil mobile | `docs/audit/mobile-01-accueil.png` |
| Vérification du CV importé (titre = nom) | `docs/audit/mobile-03-cv-analyse.png` |
| Fiche offre mobile | `docs/audit/mobile-07-fiche-offre.png` |
| Studio mobile (messages techniques) | `docs/audit/mobile-07b-studio.png` |
| Résultats bureau | `docs/audit/bureau-06-resultats.png` |
| Studio bureau (titre « Nadia Benali ») | `docs/audit/bureau-07b-studio.png` |
| Assistant (texte contradictoire) | `docs/audit/bureau-08-onglet-Assistant.png` |
| Mode sombre mobile | `docs/audit/mobile-09-sombre.png` |

## Ordre de correction conseillé

1. P0-4 (dépôt vert), puis P0-1, P0-2, P0-3 : la promesse « rien d'inventé ».
2. P1-1, P1-2, P1-5 : les métiers non techniques et les messages lisibles.
3. P1-3, P1-4, P1-6, P1-7 : coût, RGPD et sécurité avant tout lancement payant.
4. P2 par lots, chacun avec son test (règle n° 6).
