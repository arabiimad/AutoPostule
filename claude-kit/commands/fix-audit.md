---
description: Corrige les constats d'AUDIT.md par lots (priorité ou identifiants), chaque correction testée et commitée
argument-hint: "[P0 | P1 | A-03,A-07 …]"
---

Corrige les constats d'`AUDIT.md` sélectionnés : $ARGUMENTS (vide = tous les P0).

Pour CHAQUE constat, dans l'ordre de priorité :
1. Relis le constat et reproduis le problème (test qui échoue, ou script Playwright pour l'UX).
2. Planifie la correction la plus simple qui respecte `CLAUDE.md` et le skill `high-end-quality-bar`. Si elle touche plus de 5 fichiers ou change un comportement visible important, présente le plan et attends mon accord.
3. Implémente, ajoute ou adapte le test, puis lance `npm run lint && npm test && npm run build` et, si l'interface change, `npm run test:e2e`.
4. Pour l'UX : capture avant/après dans `audit/captures/` (mobile et desktop).
5. Commit dédié : `fix(A-xx): <titre>` avec le pourquoi dans le corps.
6. Coche le constat dans `AUDIT.md` (✅ + commit).

Arrête-toi et signale-moi tout constat qui exige une décision produit, un compte externe ou un secret. À la fin : tableau des constats traités, restants, et nouvelle note estimée par axe.
