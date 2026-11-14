# Réglages et traçabilité

[← Sommaire](README.md)

La **roue dentée** de l'en-tête ouvre les Réglages.

![Les Réglages](img/reglages.jpg)

Une section à la fois : le **menu de gauche** les regroupe en quatre parties, et le contenu défile à droite.

| Partie | Sections |
|---|---|
| Personnaliser | Apparence, Navigation, Rubriques, Mes actions, Missions |
| Traçabilité | Journal des actions (et rapport d'intervention), Enregistrements de sessions |
| Données | Favoris, Coffre, Sauvegardes, Configuration complète |
| Système | Proxy (bureau / maison), Serveur (mise à jour, diagnostic, application) |

Le panneau se rouvre sur la dernière section consultée. **Annuler** et **Enregistrer** restent visibles en bas, quelle
que soit la section ; **Enregistrer** enregistre toutes les sections d'un coup. Un champ invalide dans une autre section
(ex. délai de retour à l'accueil) l'affiche automatiquement. Sur un écran étroit, le menu passe en haut.

## Apparence

![Mode clair](img/mode-clair.jpg)

- Mode **sombre**, **clair** ou **système**.
- **Thème de mission** aux couleurs d'un client (en-tête, barre des touches).
- **Signature des terminaux** : texte ou image en filigrane, au fond de chaque terminal.

## Rubriques et navigation

- **Rubriques** : cocher celles de l'accueil, glisser pour l'ordre (18 touches au plus).
- **Retour automatique à l'accueil** après une action, avec un délai réglable.

## Journal des actions

Chaque action lancée depuis le deck est notée : date, touche, commande (exécutée ou tapée), terminal, contexte kubectl
(en rouge si production). Les commandes tapées à la main et les valeurs du coffre ne sont pas notées.
**Exporter (CSV)** pour Excel. Fichier `.deck-journal.jsonl`, hors Git.

## Rapport d'intervention

![Rapport d'intervention](img/rapport.jpg)

**Rapport d'intervention…** assemble un compte rendu Markdown d'une période (aujourd'hui, 4 h, depuis hier, 7 jours,
ou depuis une date) :

- les actions du journal, avec **⚠ PROD** quand c'était la production ;
- les sessions **● REC** (texte inclus sur demande) ;
- les étapes de runbook cochées (coffre déverrouillé) ;
- les **patchs réalisés** sur la période et l'**état du parc à date** (certificats et VMs par environnement), voir
  [Échéances et synthèse](14-echeances-et-synthese.md#rapport-dintervention-enrichi).

Tu le relis et le modifies, puis **Copier**, **Télécharger (.md)** ou **Enregistrer dans le coffre**. Rien n'est
envoyé ailleurs.

## Sauvegardes

Avant chaque modification des favoris, de Mes actions, des réglages ou du coffre, une copie est gardée dans
`.deck-backups/` (10 par fichier). **Restaurer** sauvegarde d'abord la version actuelle.

## Configuration complète et mise à jour

- **Configuration complète** : export / import en un fichier de tes favoris, Mes actions, réglages, missions,
  [patchs des VMs](13-patchs.md) et signature (le coffre s'exporte à part, chiffré). Idéal pour passer de ton Mac à ton PC.
- **Mettre à jour** (Réglages › Serveur) : compare avec GitHub, fait `git pull`, installe les dépendances si besoin et
  redémarre. Refusé si des fichiers suivis ont été modifiés sur la machine, pour ne rien écraser.

## Proxy : bureau ou maison

![Réglages › Proxy](img/proxy-reglages.jpg)

Pour un poste qui passe par le proxy de l'entreprise au bureau, mais pas à la maison : **Réglages › Proxy**.

| Mode | Comportement |
|---|---|
| **Automatique** (conseillé) | Proxy utilisé **s'il répond** (au bureau), connexion directe sinon (à la maison). Testé au démarrage, toutes les 2 minutes et avec **Tester maintenant** ; un message s'affiche au changement. |
| **Activé** | Toujours par le proxy. |
| **Désactivé** | Connexion directe, même si `HTTPS_PROXY` est défini dans la session. |
| **Système** | Variables `HTTPS_PROXY` / `NO_PROXY` de la session, telles quelles (comportement par défaut). |

- **Adresse du proxy** et **sans proxy (NO_PROXY)** : vides = celles des variables de la session (affichées en gris).
  Pas d'identifiants dans l'adresse : ils seraient enregistrés en clair ; garde-les dans la variable `HTTPS_PROXY`.
- Le choix s'applique à tout ce qui part du deck : vérification des certificats, **Mettre à jour** (git, en
  neutralisant un `http.proxy` de la configuration git), diagnostic, kubectl et les **nouveaux terminaux**. Les
  terminaux déjà ouverts gardent leurs variables : ouvre-en un nouveau après un changement.
- **En-tête** : le bouton **Proxy** montre l'état (pastille verte = proxy actif ; « Proxy auto · bureau » ou
  « · direct ») ; un clic change de mode immédiatement.

![Bouton Proxy de l'en-tête](img/proxy-entete.jpg)

## Diagnostic

![Diagnostic](img/diagnostic.jpg)

**Réglages › Serveur › Diagnostic** vérifie ce qui dépend du poste : presse-papiers, détection ssh / wsl,
**terminaux connectés** (surveillance active, dernier relevé, chaque ssh vu avec sa lignée de processus et la raison de
sa détection ou non : cadre de la machine, touches des VMs), outils à installer, sauvegardes, shells, lancement en service, et **réseau** : proxy (`HTTPS_PROXY`, identifiants masqués),
DNS d'un nom public, accès HTTPS (direct ou via le proxy, interception TLS signalée), accès Git pour **Mettre à jour**.

## Mode partage d'écran

![Mode partage d'écran](img/partage-ecran.jpg)

Avant une réunion ou une démo, le bouton **écran barré** de l'en-tête (pastille **PARTAGE**) floute ce qui révèle
l'infrastructure d'un client : contexte kubectl et voyants, mission, notes, secrets, listes d'hôtes et de pods,
sélecteurs, palette, réglages sensibles, rapport, lecteur. **Survoler une zone l'affiche** ; le terminal reste visible.
