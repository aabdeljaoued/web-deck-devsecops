# Prise en main

[← Sommaire](README.md)

Le deck est un petit serveur Node.js local (port **7777**) qui sert une page dans ton navigateur : une grille de
touches en haut, des terminaux en dessous. Il ne répond qu'à ta machine (`127.0.0.1`) et demande un **jeton** secret.

## Prérequis

- **Node.js 20 ou plus récent** (22 recommandé).
- Les outils que tu utilises déjà (kubectl, helm, docker, git, ssh…). Une touche dont l'outil manque le signale et
  propose la commande d'installation.

## Installation sous macOS

```bash
git clone https://github.com/aabdeljaoued/web-deck-devsecops.git
cd web-deck-devsecops
npm install
```

Lancement ponctuel : double-clic sur `start.command`.

**Lancement automatique (recommandé)** : double-clic sur `service/installer.command`. Le deck devient un service de
ta session (LaunchAgent) : il démarre avec la session et redémarre tout seul s'il s'arrête. Journal :
`~/Library/Logs/web-deck-devsecops.log`. Pour l'enlever : `service/desinstaller.command`.

## Installation sous Windows (sans droits admin)

1. Installer Node.js (version « portable » ou avec Scoop, sans droits admin).
2. Récupérer le dépôt, puis dans le dossier : `npm install`.
3. Lancement ponctuel : `start.cmd`.
4. **Lancement automatique** : `service\installer.cmd`, qui place un lanceur dans le dossier Démarrage de ta session ;
   le deck redémarre s'il s'arrête.

Sur un poste d'entreprise avec proxy, définis `HTTPS_PROXY` pour ton utilisateur (voir
[Missions et certificats](08-missions-et-certificats.md#poste-dentreprise-et-proxy)).

## Installer le deck comme application (facultatif)

En plus de l'onglet du navigateur, le deck peut s'installer comme une **application** : sa propre fenêtre (sans barre
d'adresse ni onglets), une icône dans la **barre des tâches** et le **menu Démarrer** (Windows), ou le **Dock** et le
Launchpad (macOS).

- **Réglages › Serveur › Installer l'application**, ou dans Edge / Chrome : menu **⋯ › Applications › Installer ce site
  en tant qu'application**.
- C'est le **même deck**, sur le même serveur local : le service doit tourner (voir ci-dessus). Si le serveur ne
  répond pas, la fenêtre l'explique au lieu d'une page d'erreur.
- **Aucun droit admin**, aucun `.exe` à signer : rien à faire valider sur un poste d'entreprise.
- Le navigateur **reste utilisable** en parallèle ; comme pour deux onglets, un seul pilote les terminaux à la fois
  (« Utiliser ici »).
- Pour la désinstaller : clic droit sur l'icône › Désinstaller (ou depuis `edge://apps` / `chrome://apps`).

## Premier démarrage

- La page s'ouvre toute seule ; l'adresse contient le jeton (`?token=…`), gardé ensuite dans un cookie.
- Un seul onglet pilote les terminaux : si tu en ouvres un autre, le précédent propose **« Utiliser ici »**.
- Après une mise à jour, les onglets ouverts **se rechargent tout seuls** à la reconnexion.

## Où sont mes données ?

Tout reste dans le dossier du deck, **hors Git** : favoris (`favoris.json`), coffre chiffré (`vault.enc`),
réglages et missions (`settings.json`), Mes actions (`actions.json`), journal (`.deck-journal.jsonl`),
enregistrements (`.deck-recordings/`), sauvegardes (`.deck-backups/`). Pour passer d'un poste à l'autre, voir
[Réglages › Configuration complète](10-reglages-et-tracabilite.md#configuration-complète-et-mise-à-jour).
