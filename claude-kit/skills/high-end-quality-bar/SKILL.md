---
name: high-end-quality-bar
description: Référentiel « application haut de gamme » d'AutoPostule (code, sécurité, UX, contenu, performance, produit). À utiliser pour tout audit, revue de code, revue de design ou avant de déclarer une fonctionnalité terminée.
---

# Référentiel de qualité AutoPostule

Chaque constat se note : **P0** (bloquant : perte de données, faille, promesse fausse, parcours principal cassé), **P1** (frustre ou fait fuir un utilisateur), **P2** (finition), **P3** (idée). Un constat = preuve (fichier:ligne, capture ou reproduction) + impact utilisateur + correction proposée + effort (S/M/L).

## 1. Logique produit
- Le parcours principal est évident en moins de 10 secondes : chercher → préparer le dossier (CV + lettre) → postuler sur le site → suivre et relancer.
- Aucun état où l'utilisateur perd son travail (visiteur → compte, rechargement, fermeture d'une fenêtre, erreur réseau, quota atteint en pleine rédaction).
- Le forfait gratuit fait vivre la valeur avant de bloquer ; le blocage explique quoi, pourquoi, et la suite.
- Rien n'est promis (Tarifs, textes, boutons) sans exister ; les libellés disent ce que fait le bouton (« Candidature express » n'envoie rien à la place du candidat).
- Tous les états existent : vide, chargement, erreur, hors ligne, démo, quota atteint, succès.

## 2. Expérience et interface
- Hiérarchie visuelle nette, une action principale par écran, vocabulaire non technique (LaTeX, Overleaf, JSON cachés derrière « Avancé »).
- Attentes IA > 2 s : étapes visibles et possibilité d'annuler ; > 10 s : explication.
- Mobile d'abord : 360 px sans défilement horizontal, cibles tactiles ≥ 44 px, fenêtres plein écran.
- Cohérence : composants de `src/components/ui.tsx`, espacements, rayons, couleurs de la marque, mode sombre sans texte illisible.
- Micro-textes : clairs, sans jargon, erreurs actionnables (« Que faire maintenant »), pas de message technique brut.
- Accessibilité WCAG 2.1 AA : focus visible, ordre de tabulation, rôles ARIA, `aria-live` pour les résultats, contrastes.

## 3. Code
- Types stricts (pas de `any` nouveau sans raison), fonctions courtes, composants < 300 lignes, logique métier hors des composants.
- Pas de duplication de règles métier entre client et serveur ; le serveur fait foi (quotas, forfait, droits).
- Erreurs gérées aux frontières (API, IA, Supabase, Stripe) avec délai d'expiration et repli.
- Tests : chaque règle métier a un test ; parcours critiques couverts en e2e.

## 4. Sécurité et données
- Entrées validées côté serveur (taille, type, format) ; aucune injection de consignes dans les prompts IA (données entre délimiteurs).
- RLS vérifiée sur chaque table ; clé service_role jamais dans le navigateur ; webhook Stripe signé.
- Limites de débit et quotas non contournables (changement d'IP, compte supprimé/recréé, requêtes parallèles).
- En-têtes de sécurité (CSP, HSTS, X-Frame-Options), cookies, CORS, dépendances sans vulnérabilité connue.
- RGPD : minimisation, export, suppression effective, durée de conservation, aucune donnée de CV dans les journaux.

## 5. Performance et fiabilité
- Chargement initial < 2,5 s en 4G (LCP), paquet JS principal < 250 ko gzip, découpage par écran.
- Aucune requête inutile au démarrage ; cache des recherches ; pas de rendu excessif.
- Serveur : arrêt propre, Chromium limité en parallèle, journaux structurés, alertes d'erreur.

## 6. Qualité du contenu IA
- CV : aucune invention (tests de garde-fous), verbes d'action, puces courtes, mots-clés de l'offre seulement s'ils décrivent le vrai parcours.
- Lettre : spécifique à l'entreprise, 250-350 mots, sans formules creuses.
- Évaluer sur 5 profils variés (RH, comptable, logistique, commerce, développeur) avant toute modification des prompts.
