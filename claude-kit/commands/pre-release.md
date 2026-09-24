---
description: Vérification avant mise en production (tests, sécurité, performance, textes, promesses)
---

Vérifie qu'AutoPostule peut être mis en ligne. Ne modifie rien sans me demander.

1. `npm ci && npm run lint && npm test && npm run build && npm run test:e2e` ; `npm audit --omit=dev`.
2. Lighthouse (mobile) sur l'accueil et la page Tarifs via le serveur de production : performance, accessibilité, bonnes pratiques, SEO ≥ 90 ; sinon liste des causes.
3. Sécurité : en-têtes HTTP, RLS (`supabase/migrations`), aucune clé secrète dans `dist/` (`grep -r "service_role\|sk_live\|sk_test" dist`).
4. Produit : chaque promesse de `PricingView.tsx` et du README existe réellement ; aucun texte « bientôt », « TODO », « lorem » visible.
5. Variables : liste des variables d'environnement requises en production (d'après `.env.example`) et celles qui manquent — sans lire `.env`.
Rends un verdict GO / NO-GO avec les points bloquants.
