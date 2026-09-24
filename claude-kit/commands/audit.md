---
description: Audit complet d'AutoPostule (code, sécurité, UX réelle, produit) consolidé dans AUDIT.md, sans modifier le code
argument-hint: "[zone optionnelle : code | securite | ux | produit]"
---

Réalise un audit « application haut de gamme » d'AutoPostule. Zone demandée : $ARGUMENTS (vide = tout).

Règles : tu ne modifies aucun fichier de l'application ; tu ne lis jamais `.env` ; tu écris seulement `AUDIT.md` et le dossier `audit/`.

1. Lis `CLAUDE.md` et le skill `high-end-quality-bar`.
2. Lance EN PARALLÈLE les sous-agents concernés : `code-auditor`, `security-auditor`, `ux-auditor`, `product-strategist`. Donne à chacun la zone demandée et rappelle le format des constats.
3. Consolide dans `AUDIT.md` :
   - **Synthèse** (10 lignes) : note globale /10 par axe (code, sécurité, UX, produit), les 5 risques majeurs, ce qui est déjà excellent.
   - **Tableau des constats** dédoublonnés et identifiés (A-01, A-02…) : priorité, axe, titre, preuve, impact, correction, effort. Trié P0 → P3, puis par rapport impact/effort.
   - **Plan d'action** en 3 lots : Lot 1 = P0 (avant toute mise en ligne), Lot 2 = P1 à fort impact (avant la commercialisation), Lot 3 = finitions.
   - **Critères de réussite** mesurables par lot (tests, temps de parcours, score Lighthouse, etc.).
4. Vérifie chaque P0 toi-même (reproduction ou lecture du code) : retire ceux qui ne tiennent pas.
5. Termine par un résumé de 5 lignes et la commande à lancer ensuite : `/fix-audit P0`.
