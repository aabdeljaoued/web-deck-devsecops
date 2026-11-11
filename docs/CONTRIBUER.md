# Contribuer à la documentation

[← Sommaire](README.md)

Cette documentation suit l'approche **Doc as Code** : des fichiers Markdown dans `docs/`, versionnés avec le code.

## La règle

**Chaque amélioration, correction ou nouvelle fonctionnalité met à jour la documentation dans le même commit** :
la page concernée, et la capture d'écran si l'interface a changé. Le `README.md` à la racine reste la référence
technique (configuration, détails) ; `docs/` est le guide d'utilisation.

## Organisation

- `README.md` : sommaire (toutes les pages doivent y figurer).
- `NN-sujet.md` : une page par thème, avec un lien de retour au sommaire.
- `img/` : captures d'écran en JPEG, 1280 px de large (`sips -s format jpeg -s formatOptions 72 --resampleWidth 1280`).

## Captures d'écran

Elles sont prises sur un **deck de démonstration**, jamais sur les données réelles :

- une copie du deck sur un autre port (7778), avec un dossier personnel **fictif** (`HOME` et `ZDOTDIR` pointant vers
  un dossier de démonstration : invite neutre, hôtes SSH et clés factices) ;
- favoris, Mes actions, missions, notes et secrets **inventés** (`*.example.test`) ;
- coffre de démonstration avec un mot de passe généré ;
- avant chaque capture : aucun nom d'utilisateur, nom de machine ou chemin personnel visible.

## Vérifications automatiques

`npm test` (et la CI GitHub) vérifie que :

- chaque lien vers une page ou une image de `docs/` existe ;
- chaque image de `docs/img/` est utilisée (pas d'image orpheline) ;
- chaque page figure au sommaire et renvoie au sommaire.

## Lire la documentation dans le deck

Le bouton **?** de l'en-tête ouvre ces pages dans le deck (images comprises) ; les liens entre pages y fonctionnent.
