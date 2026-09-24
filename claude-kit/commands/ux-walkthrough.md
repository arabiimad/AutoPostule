---
description: Parcours utilisateur réel dans un navigateur, avec captures desktop/mobile et critique UX
argument-hint: "[persona ou parcours, ex. « Léa mobile » ou « import CV Word »]"
---

Utilise le sous-agent `ux-auditor` pour le parcours : $ARGUMENTS (vide = les 3 personas du sous-agent).

Exige des captures dans `audit/captures/` pour chaque étape, en 390×844 et 1440×900. Rends la liste des constats priorisés et, pour les 3 plus importants, une proposition concrète : nouveau texte exact, nouvelle disposition décrite ou esquissée en HTML statique dans `audit/maquettes/`.
Ne modifie pas le code de l'application.
