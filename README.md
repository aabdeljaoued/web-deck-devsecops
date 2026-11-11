# Web Deck DevSecOps

Le deck DevSecOps dans le navigateur, **sans Stream Deck ni droits administrateur** : une grille de touches (Git, Kubernetes, Docker, Helm, Terraform, Ansible, Brew / Scoop, SSH, OpenSSL, Linux / Unix, veille sécurité…), des voyants en direct (contexte kubectl, branche Git, conteneurs) et un **vrai terminal intégré** (PowerShell, Git Bash, cmd ou zsh) dans lequel les touches tapent leurs commandes.

```
config.jsonc   QUOI afficher : rubriques, raccourcis, outils exclus, port
paths.json     OÙ sont les logiciels et les shells, par système (paths.<machine>.json fusionné par-dessus)
server/        serveur Node.js : pages, terminaux (node-pty), voyants, lanceurs
public/        page web : grille + terminal (xterm.js), sans étape de build
start.cmd      lanceur Windows (double-clic)
start.command  lanceur macOS (double-clic dans le Finder)
start.sh       lanceur macOS / Linux en ligne de commande
```

## Documentation

Le guide complet, page par page avec des captures d'écran, est dans **[docs/](docs/README.md)** (*Doc as Code* :
mis à jour avec chaque évolution, liens et images vérifiés par `npm test`). Il s'ouvre aussi dans le deck avec le
bouton **?** de l'en-tête.

## Application installée (facultatif)

Le deck peut aussi s'installer comme **application** (fenêtre à part, icône dans la barre des tâches, le menu Démarrer
ou le Dock) : **Réglages › Serveur › Installer l'application**, ou dans Edge / Chrome **⋯ › Applications › Installer ce
site en tant qu'application**. C'est le même deck, servi par le même service local ; le navigateur reste utilisable. Elle partage le cookie du jeton avec le navigateur : si elle affiche « Accès refusé », ouvre une fois l'adresse complète (la page donne la commande).
Aucun droit admin ni `.exe` à signer. Manifeste, service worker (sans cache) et icônes sont les seuls fichiers lisibles
sans jeton.

## Installation sous Windows sans droits admin

1. **Node.js** (20 ou plus), au choix :
   - **portable** : télécharger le zip « Windows Binary (.zip) » x64 sur [nodejs.org](https://nodejs.org/en/download), l'extraire dans un dossier `node` **à la racine du projet** (`node\node.exe`). `start.cmd` l'utilise automatiquement ;
   - ou `winget install OpenJS.NodeJS.LTS --scope user` si winget est autorisé ;
   - ou via [Scoop](https://scoop.sh) (installation utilisateur) : `scoop install nodejs-lts`.
2. **Récupérer le projet** (git clone ou zip), puis double-cliquer sur **`start.cmd`**. Au premier lancement, et après une mise à jour qui change les dépendances, il installe les dépendances (`npm install`), démarre le serveur et ouvre le navigateur.

Aucune compilation n'est nécessaire : `node-pty` embarque ses binaires pour Windows (x64, ARM64) et macOS (Intel, Apple Silicon).

Shells détectés sous Windows : PowerShell 7 (`pwsh`), Windows PowerShell, Git Bash (installation système, utilisateur ou Scoop) et cmd.

## Installation sous macOS

1. **Node.js** (20 ou plus) : `brew install node`, ou l'archive macOS (`.tar.gz`) de [nodejs.org](https://nodejs.org/en/download) extraite dans un dossier `node` à la racine du projet (`node/bin/node`).
2. Double-cliquer sur **`start.command`** dans le Finder (ou `./start.sh` dans un terminal). Fermer la fenêtre Terminal arrête le deck.
   Si le projet vient d'un zip téléchargé, macOS peut bloquer le lanceur : clic droit › Ouvrir, ou `xattr -dr com.apple.quarantine .` dans le dossier.

### Lancement automatique (service de session, recommandé)

Pour que le deck démarre avec la session, tourne **sans fenêtre** et **redémarre tout seul** s'il s'arrête, sans droits administrateur :

| | Installer | Désinstaller | Journal |
|---|---|---|---|
| macOS | double-clic sur `service/installer.command` (LaunchAgent) | `service/desinstaller.command` | `~/Library/Logs/web-deck-devsecops.log` |
| Windows | double-clic sur `service\installer.cmd` (dossier Démarrage, lancement caché) | `service\desinstaller.cmd` | `%LOCALAPPDATA%\web-deck-devsecops\deck.log` |

Journaux : au démarrage, un journal de plus de 1 Mo est mis de côté (`.1`, le précédent est remplacé) et un nouveau commence.

L'installation arrête un deck lancé à la main (ses terminaux sont rouverts) et ouvre le navigateur. Lancé à la main avec `start.command` / `start.cmd`, fermer la fenêtre arrête le deck. **Réglages › Serveur** indique le mode de lancement et propose **Redémarrer le deck** (deux clics ; les commandes en cours s'arrêtent, les terminaux sont rouverts) : en service, c'est le service qui le relance ; lancé à la main, une nouvelle copie détachée de la fenêtre démarre (journal `.deck.log`).

Sans les outils de ligne de commande Xcode, `git` est considéré comme absent (sinon macOS ouvrirait une fenêtre d'installation à chaque rafraîchissement du voyant) : `xcode-select --install`.

La touche **Verrouiller** (raccourci `lock`, à ajouter dans `shortcuts` de `config.jsonc`) met l'écran en veille (`pmset displaysleepnow`) : elle ne verrouille que si *Réglages Système › Écran verrouillé › Exiger un mot de passe* est réglé sur « Immédiatement ».

Linux fonctionne aussi (`./start.sh`) : sans bloc `linux` dans `paths.json`, celui de `mac` est utilisé.

## Utilisation

### Touches

- **Infobulle** : au survol, ce que fait l'action en quelques mots, la commande et son comportement. Textes dans `server/descriptions.mjs` ; une touche de `config.jsonc` peut avoir `"description"`.
- **Pastille verte** : la commande est tapée **et exécutée** dans le terminal actif.
- **Pastille orange** : la commande est seulement tapée, tu complètes ou valides toi-même (commandes à compléter ou risquées).
- **Texte sélectionné** : sur une touche orange, le texte sélectionné dans le terminal est ajouté à la commande (à l'emplacement `{}` s'il y en a un, ex. `kubectl exec -it {} -- sh`) ; sans sélection, le curseur est placé sur `{}`. Rien n'est jamais exécuté sans Entrée.
- **Retour** à gauche ; **clear** collé au bord droit, sur l'accueil comme dans les rubriques.
- Les touches tapent la variante adaptée au shell de l'onglet actif (ex. `$env:VAULT_ADDR=` dans PowerShell, `export VAULT_ADDR=` dans bash/zsh, `set VAULT_ADDR=` dans cmd). Une touche sans variante pour ce shell affiche un message.
- **Linux / Unix** : l'administration courante d'un serveur, le plus souvent après un `ssh` (commandes Linux, tapées telles quelles quel que soit le shell local). Exécutées : système (`uname`, `/etc/os-release`, `uptime`), top (`htop` sinon `top`), mémoire (`free -h`), disque (`df -h`), gros dossiers (`du | sort -h`), ports (`ss -tulpn`), services en cours (`systemctl`), erreurs du démarrage (`journalctl -p err -b`). À compléter, avec le texte sélectionné : processus (`pgrep -af`), kill, statut / restart / logs d'un service (`systemctl`, `journalctl -u … -f`), `tail -f`, find, grep.
- **Raccourcis clavier** : `⌥1` … `⌥9` puis `⌥0` (Alt sous Windows) lancent les dix premières touches d'action de la page affichée (sans Retour ni clear) ; garder `⌥` enfoncée affiche leurs numéros.
- **Mode partage d'écran** (bouton écran barré de l'en-tête, pastille **PARTAGE**) : avant une réunion ou une démo, floute ce qui révèle l'infrastructure d'un client (contexte kubectl et voyants, mission, notes, secrets, listes d'hôtes et de pods, sélecteurs, palette, réglages sensibles, rapport, lecteur) ; **survoler une zone l'affiche**. Le terminal reste visible. Gardé d'une session à l'autre.
- **Palette de commandes** (`⌘K` / `Ctrl+K`, ou « Rechercher » en haut à droite) : tape quelques lettres (`exec`, `plan`, `logs`, `grafana`…) pour trouver et lancer n'importe quelle touche, sans passer par les rubriques. Les **commandes récentes** lancées depuis le deck (journal) y figurent aussi, avec leurs valeurs : Entrée les **tape sans les lancer** (Entrée dans le terminal pour exécuter). Elle cherche aussi (sans tenir compte des accents) les **missions** (Entrée l'active ou la désactive) et, coffre déverrouillé, les **notes** (titre et contenu : Entrée l'ouvre) et les **secrets** (nom, identifiant, adresse : Entrée **copie** la valeur, effacée du presse-papiers après 30 s ; la valeur ne passe jamais par la page).

### Apparence : mode sombre / clair et thèmes de mission

Dans **Réglages** (engrenage en haut à droite), rubrique **Apparence** :

- **Mode** : **Sombre** (défaut), **Clair**, ou **Système** (suit le réglage de macOS / Windows, et change avec lui). En mode clair, toute l'interface passe en clair, terminal compris ; les touches deviennent des tuiles claires avec l'icône et le halo de leur rubrique.
- **Thème de mission** : **Allianz**, **BNP Paribas**, **Estreem**, **La Poste** (ou aucun), dans les deux modes. Le thème colore l'en-tête, la barre des touches, le liseré et les éléments actifs (onglet, terminal sélectionné, boutons) ; les touches gardent leurs couleurs par outil pour rester repérables.

- **Signature des terminaux** : un texte (ton nom, par exemple) affiché en filigrane gris et flou au fond de chaque terminal, derrière le texte ; vide = aucune. **Style** : texte simple, ou **bannière ASCII** (grandes lettres en caractères, façon FIGlet) avec une **police** au choix (ANSI Shadow, Standard, Slant, Big, Small, Doom, Banner3, Block), taille ajustée à chaque terminal. **Image de signature…** utilise à la place une image PNG sur fond transparent (signature manuscrite), peinte dans le même gris ; elle est enregistrée dans `signature.png` (exclu de Git), **Retirer l'image** revient au texte.

Le choix s'affiche en aperçu immédiat et n'est gardé qu'avec **Enregistrer** (Annuler revient à l'apparence d'avant). Il est enregistré côté serveur dans `settings.json`, donc le même dans tous les navigateurs.

| Thème | Couleurs | Source |
|---|---|---|
| Allianz | bleu `#003781` (Pantone 288 C) | valeur la plus citée, non vérifiée sur la charte officielle |
| BNP Paribas | vert `#00965E` (Pantone 340 C) | valeur la plus citée, non vérifiée sur la charte officielle |
| Estreem | bleu nuit `#002D41`, cyan `#0FA5B6` | relevées dans les styles d'estreem.fr |
| La Poste | jaune `#FFCB05`, bleu `#003DA5` | relevées dans les styles de laposte.fr |

Les valeurs sont dans `public/style.css` (blocs `[data-theme="…"]`) : à ajuster avec la charte officielle si besoin. Les logos des marques ne sont pas utilisés.

### Favoris

La rubrique **Favoris** regroupe tes sites liés à la mission (Jira, Confluence, Grafana, Argo CD, GitLab, consoles cloud…), rangés en **groupes** et **sous-groupes** :

- **Ajouter** : choisir **Site** (adresse — le `https://` est ajouté s'il manque —, nom par défaut le nom de domaine) ou **Groupe** (nom). **Dans** indique où le ranger (préréglé sur le groupe affiché). Icône facultative : sans icône, celle d'un site est devinée d'après l'adresse (GitHub, GitLab, Jira / Confluence, Grafana, Jenkins, Argo, Kibana, Vault, Harbor, Sonar…), sinon un globe ; un groupe a un dossier.
- **Couleur d'un groupe** : à la création ou en modification, une palette de 10 couleurs ou n'importe quelle couleur (sélecteur du système). Les sites du groupe prennent sa couleur ; un sous-groupe peut avoir la sienne.
- **Groupes** : un groupe s'ouvre comme une rubrique et peut contenir des sites et des **sous-groupes** ; un sous-groupe ne contient que des sites (deux niveaux). **Retour** remonte d'un niveau ; le fil en haut (`Accueil › Favoris › Mission X › Monitoring`) est cliquable.
- **Glisser-déposer** (à tout moment) : une touche lâchée sur le bord gauche ou droit d'une autre se place avant ou après elle ; au centre d'un groupe, elle entre dans le groupe ; sur **Retour**, elle remonte d'un niveau.
- **Modifier** : les éléments se mettent à trembler ; un clic ouvre leur formulaire pour les renommer, changer de groupe (**Dans**), les déplacer (◀ ▶) ou les supprimer. Supprimer un groupe supprime son contenu, après un second clic de confirmation qui indique le nombre d'éléments. **Terminé** pour revenir à la normale.
- **Toujours à portée de main** : la touche Favoris est fixée à gauche de **clear**, sur l'accueil et dans chaque rubrique. Ouverte depuis une rubrique, elle y ramène après le choix d'un site, ou au bout de **30 s** sans choix (barre de temps sous les touches) ; **Retour** depuis le haut des favoris y ramène aussi.
- Jusqu'à 12 éléments par niveau, sans limite au total. Tous les sites et groupes apparaissent dans la palette (`⌘K`).
- Enregistrés dans `favoris.json` à la racine du projet, **exclu de Git** : les adresses internes de la mission ne partent pas sur le dépôt. Le fichier peut aussi être édité à la main (sites `label` / `url` / `icon`, groupes `type: "group"` / `label` / `items`), puis le serveur redémarré.
- **D'une machine à l'autre** : Réglages › Favoris › **Exporter…** télécharge `favoris-deck-AAAA-MM-JJ.json` ; sur l'autre machine, **Importer…** ce fichier puis **Fusionner** (ajoute ce qui manque : groupes de même nom réunis, sites déjà présents ignorés) ou **Remplacer tout** (deux clics). Un import trop gros pour un niveau (12 éléments) est refusé en entier, sans rien modifier. Le fichier contient les adresses de mission : à garder hors des dépôts et partages publics.

### Coffre : notes et secrets

Le bouton **Coffre** (en haut à droite, ou « coffre » dans la palette `⌘K`) ouvre un coffre chiffré pour les **notes** de mission et les **secrets** (tokens, mots de passe).

- **Création** : au premier usage, choisir un **mot de passe maître** (8 caractères minimum). **Mot de passe oublié = contenu perdu** : il n'existe aucune récupération.
- **Notes** : liste à gauche, éditeur à droite, enregistrement automatique pendant la frappe, recherche. Écrites en **Markdown** (titres, listes et cases à cocher, **gras**, `code`, blocs de code, citations, tableaux, liens) : **Aperçu** pour le rendu, **Afficher dans le terminal ▸** pour l'afficher mise en forme dans le terminal actif (rien n'est envoyé au shell, les caractères de contrôle de la note sont neutralisés). On y sélectionne ensuite une partie (une commande, un nom de pod…) puis on clique une touche d'action, qui la reprend comme toute sélection ; les lignes de code n'ont aucun décor, la sélection reste propre. Dans l'**Aperçu**, chaque **ligne de code est cliquable** : elle est tapée dans le terminal (sans Entrée, le coffre se ferme) et marquée ✓ pour suivre une procédure pas à pas ; **Copier** copie tout le bloc. Plus direct encore : **sélectionner du texte dans la note** (éditeur ou aperçu) puis fermer le coffre : la **prochaine touche « à compléter »** l'insère (une seule fois ; une sélection dans le terminal reste prioritaire ; oubliée après 10 min ou au verrouillage du coffre). L'**avancement** (lignes ✓) est gardé dans le coffre, chiffré avec la note : en rouvrant la note, même plus tard, la procédure reprend où elle en était ; **Recommencer** remet tout à zéro. Une **couleur** par note (pastilles sous le titre, ou couleur libre) : bandeau dans la liste et en haut de l'éditeur ; chiffrée avec le reste du coffre. **Exporter** enregistre la note en Markdown (`.md`, **en clair**) pour la partager ; si elle semble contenir un secret (mot de passe, token, clé privée), un second clic est demandé. **Importer** (à côté de « + Note ») ajoute des fichiers `.md` comme notes chiffrées (titre = nom du fichier).
- **Secrets** : nom, identifiant, valeur (bouton **Générer** : 24 caractères aléatoires), adresse, note. La liste n'affiche que les noms, valeurs masquées :
  - **Copier** : le serveur copie la valeur dans le presse-papiers du système (`pbcopy` sous macOS, PowerShell sous Windows, `wl-copy` / `xclip` sous Linux) sans qu'elle passe par la page, puis l'efface au bout de 30 s si le presse-papiers la contient toujours (tout de suite si le deck s'arrête ou redémarre avant) ;
  - **Taper ▸** : écrit la valeur dans le terminal actif, sans Entrée, **côté serveur** (elle ne passe pas par la page). À utiliser devant une demande de mot de passe (saisie masquée) : devant une invite de commande ordinaire, la valeur s'afficherait en clair et irait dans l'historique du shell après Entrée ;
  - **Afficher** : montre la valeur 15 s.
- **Verrouillage** : bouton **Verrouiller**, automatiquement après 15 min d'inactivité, **quand la session est verrouillée** (écran de verrouillage macOS ou Windows), et à l'arrêt du serveur. Verrouillé, plus rien du contenu n'est gardé dans la page ni en mémoire du serveur.

Sécurité : fichier `vault.enc` à la racine du projet, **exclu de Git**, lisible par l'utilisateur seul, chiffré en **AES-256-GCM** avec une clé dérivée du mot de passe maître par **scrypt** ; chaque échec de mot de passe ralentit la tentative suivante (jusqu'à 5 s). Les valeurs des secrets ne quittent le serveur que sur demande explicite (Afficher) ; Copier et Taper les écrivent côté serveur. Pour sauvegarder le coffre, copier `vault.enc` (il reste chiffré).

**D'une machine à l'autre** : Réglages › Coffre › **Exporter…** (coffre déverrouillé) télécharge `coffre-deck-AAAA-MM-JJ.json`, toujours chiffré par le mot de passe maître. Sur l'autre machine, **Importer…** ce fichier et saisir le mot de passe maître **du fichier** :
- **Utiliser ce coffre** (aucun coffre sur cette machine) : le fichier devient le coffre, déverrouillé ;
- **Fusionner** (coffre déverrouillé) : ajoute les notes et secrets manquants, garde la version la plus récente d'un même élément ; le coffre garde son propre mot de passe ;
- **Remplacer tout** (coffre déverrouillé, deux clics) : l'ancien coffre est copié dans `vault.enc.bak` (exclu de Git), le nouveau s'ouvre avec le mot de passe du fichier.

Un mauvais mot de passe ne modifie rien (et ralentit l'essai suivant, comme le déverrouillage). Vérifier que la politique de sécurité du client autorise ce type de stockage pour ses identifiants.

### Réglages et retour automatique à l'accueil

Après une action dans une rubrique (Docker, K8s, Git, un groupe de favoris…), le deck revient tout seul à l'accueil si aucune autre action n'y est lancée pendant **60 secondes** ; chaque action relance le compte à rebours. Une fine barre en bas des touches montre le temps restant. Le décompte se met en pause (barre grise) tant qu'un formulaire, le coffre, la palette ou un sélecteur est ouvert, ou en mode Modifier des favoris.

**Réglages** (engrenage en haut à droite) : une section à la fois, avec un menu à gauche en quatre parties (Personnaliser : Apparence, Navigation, Rubriques, Mes actions, Missions ; Traçabilité : Journal, Enregistrements ; Données : Favoris, Coffre, Sauvegardes, Configuration complète ; Système : Serveur). Le panneau garde une hauteur fixe, se rouvre sur la dernière section consultée, et **Annuler** / **Enregistrer** restent toujours visibles.

Dans **Réglages**, section Navigation : une case active ou désactive le retour automatique, et le délai (de 5 à 3600 secondes) s'affiche quand il est activé. Désactiver garde le délai choisi pour la prochaine réactivation, et arrête un compte à rebours en cours. Les réglages sont enregistrés côté serveur dans `settings.json` (exclu de Git), les mêmes pour tous les onglets et navigateurs.

### Ansible sous Windows (via ssh ou wsl)

Ansible ne s'exécute que sous Linux ou macOS. Sous Windows, la rubrique **Ansible** est affichée mais ses touches sont **grisées** (« ssh requis ») ; elles **s'activent** dès que le terminal actif est connecté à une machine Linux / macOS : une session `ssh` (ou `mosh`) ou `wsl` lancée depuis le shell. L'onglet du terminal porte alors un badge **SSH** ou **WSL**, et les touches tapent leurs commandes dans la session distante ; à la déconnexion (ou sur un autre terminal), elles se regrisent. Un `ssh` lancé par un autre programme (`git push`, `scp`…) ne compte pas. Détection : `server/remote.mjs` (liste des processus toutes les 2,5 s).

### Outils non installés

Les touches d'un outil installable absent (stern, popeye, dive, gitleaks, delta, lazygit, trivy, checkov, semgrep, ssh-audit, kubectl, helm, terraform, vault…) sont **grisées** avec la mention « à installer ». Un clic tape la commande d'installation sans l'exécuter (`brew install …` sur macOS, `scoop install …` ou `pip install …` sur Windows). Après ce clic, le serveur surveille l'installation (toutes les 3 s pendant 5 min) : la touche se rallume dès la fin de l'installation. Sinon, la vérification se refait toutes les minutes, au retour sur l'onglet et à l'ouverture d'une rubrique qui contient des touches grisées. Les commandes Linux faites pour un serveur distant (`systemctl`, `ss`…) ne sont pas concernées, ni sous Windows les outils sans commande d'installation (ansible-lint, htop : ils servent via ssh). Si le gestionnaire de paquets manque (Scoop sous Windows), le clic tape d'abord sa commande d'installation officielle, sans droits admin. Liste et paquets : `server/tools.mjs`.

### Sauvegardes automatiques

Avant chaque modification de `favoris.json`, `vault.enc` ou `settings.json`, la version actuelle est copiée dans `.deck-backups/` (exclu de Git, lisible par l'utilisateur seul) : au plus une copie toutes les 10 minutes, toujours avant une opération destructrice (Remplacer tout, restauration), 10 copies gardées par fichier. **Réglages › Sauvegardes** les liste et permet d'en **restaurer** une (deux clics) ; la version actuelle est d'abord sauvegardée, donc une restauration se rattrape. Le coffre restauré est verrouillé : il s'ouvre avec le mot de passe maître de l'époque.

### Journal des actions

**Rapport d'intervention** (Réglages › Journal › *Rapport d'intervention…*) : compte rendu Markdown d'une période (aujourd'hui, 4 dernières heures, depuis hier, 7 jours, ou depuis une date) : actions du journal (heure, commande, contexte kubectl, **PROD** signalée), sessions **● REC** (texte inclus sur demande, 200 dernières lignes par session) étapes de runbook cochées (coffre déverrouillé), **patchs réalisés** sur la période et **état du parc à date**. Le texte s'affiche pour relecture et modification, puis **Copier**, **Télécharger (.md)** ou **Enregistrer dans le coffre** (note chiffrée). Rien n'est envoyé ailleurs.

**Réglages › Journal des actions** : chaque action lancée depuis le deck (touche, palette, raccourci) est notée avec la date, la commande (exécutée ou tapée), le terminal et le contexte kubectl, en rouge si c'est la production. Liste des dernières actions, **export CSV** (Excel), effacement (deux clics), case pour désactiver. Les commandes tapées à la main et les valeurs du coffre ne sont pas notées. Fichier `.deck-journal.jsonl` (hors Git, 5 000 entrées gardées).

### Garde-fou production

Quand le voyant kubectl est en **production** (contexte ou namespace qui correspond à `prodPattern` de `config.jsonc`, par défaut `prod|prd`), les touches qui agissent sur le cluster (**exec -it**, **helm upgrade -i**, **rollback**, **uninstall**) sont entourées de rouge avec la mention **PROD** : le premier clic affiche le contexte et arme la touche, le **deuxième clic** (dans les 5 s) la lance. **Voir avant d'appliquer** : en production, **upgrade -i** (Helm) et **apply -f** (K8s) tapent d'abord la comparaison, `helm diff upgrade --install` (extension [helm-diff](https://github.com/databus23/helm-diff)) ou `kubectl diff -f`, avec le texte sélectionné ; on la lance (Entrée) et on lit ce qui va changer, puis un **second clic dans la minute** tape la vraie commande, avec la même sélection. Changer de contexte ou de namespace (voyant **kubectl** de l'accueil, ou touche **contexte / ns** de la rubrique K8s) vers une production demande aussi **un second clic** dans le sélecteur. Les terminaux prennent aussi un **bord rouge** avec le bandeau **PRODUCTION · contexte / namespace**, tant que le contexte reste en production.

### Missions (un profil par client)

**Réglages › Missions › Nouvelle mission…** enregistre un profil : nom, **thème**, **rubriques affichées et leur ordre** (reprises des réglages actuels), **motif de production** du voyant kubectl (vide = `prodPattern` de `config.jsonc`), **dossier des nouveaux terminaux** et **groupe de favoris** ouvert directement par la touche Favoris. Le sélecteur **Mission** de l'en-tête (affiché dès qu'une mission existe) l'active en un clic : thème et rubriques appliqués (refusé si l'accueil dépasse 18 touches), voyant kubectl et garde-fou production avec le motif de la mission. « Mission : aucune » rend le motif et le dossier par défaut. Tant qu'une mission est active, ce qui est changé dans **Rubriques** (choix et ordre) et le **thème de mission** est enregistré dans cette mission : la réactiver ou la modifier ne fait pas revenir les anciennes rubriques. Les missions sont enregistrées dans `settings.json` (hors Git).

**Variables de mission** : dans le formulaire, une par ligne (`registry = harbor.client.fr`, `ns = app-prod`…). Une commande (Mes actions ou `config.jsonc`) les utilise avec `{mission.registry}` : la valeur vient de la mission active, la même touche sert donc chez chaque client. Sans mission active, ou si la variable manque, la touche ne tape rien et le dit.

**Certificats à surveiller** : une adresse par ligne (`api.client.fr`, `ldap.client.fr:636`), suivie de son environnement (`production`, `recette`, `qualification`, `développement`, `autre` ; `prod`, `rec`, `dev` acceptés ; sans rien = production). Production : orange < 30 j, rouge < 7 j, alertes aux deux seuils ; hors production : orange < 14 j, rouge < 3 j, alerte au rouge seulement. Le voyant suit la production (**CERTS PROD**) et signale à part les problèmes hors production (« 1⚠ hors prod »), le panneau sépare Production et Hors production. Le voyant **certificats** de la rubrique OpenSSL (ou `cert-status` dans `shortcuts`) montre le plus proche de l'expiration : vert, **orange à moins de 30 jours**, **rouge à moins de 7** ou expiré ; **un clic** ouvre la liste de tous les certificats suivis (pastille, jours restants, date, chaîne non reconnue, serveur injoignable avec la raison en clair : réseau inaccessible, nom inconnu, port fermé…) et relance la vérification ; sinon vérification toutes les 30 min. La date est lue par une simple poignée de main TLS (Node, sans openssl, 10 s au plus). **Réseau d'entreprise avec proxy** (ex. Zscaler) : si `HTTPS_PROXY` (ou `https_proxy`) est défini, la vérification passe par un tunnel `CONNECT` du proxy (identifiants de l'URL acceptés), `NO_PROXY` est respecté ; sous Windows, définir la variable pour l'utilisateur (`setx HTTPS_PROXY http://proxy:8080`) puis redémarrer le deck. Le panneau indique l'**émetteur** et le passage par le proxy ; un certificat présenté par un proxy qui déchiffre le TLS (Zscaler, Netskope…) est signalé ⚠ et ne compte pas pour la couleur, sa date n'étant pas celle du site. Erreurs distinguées : DNS, proxy injoignable, proxy qui refuse (403, 407, 502…), délai dépassé. **Alerte** quand un certificat passe à l'orange (moins de 30 jours) puis au rouge (moins de 7 jours ou expiré) : message dans le deck et notification du système si elles sont autorisées (cloche de la barre des terminaux) ; une seule fois par seuil, retenue dans `.deck-cert-alerts.json` (hors Git), de nouveau après un renouvellement.

### Rubriques activées

Dans **Réglages › Rubriques**, une case par monde (VS Code, Git, K8s, Docker…) l'affiche ou le masque sur l'accueil ; masqué, il disparaît aussi de la palette ⌘K. Les rubriques du catalogue absentes de `config.jsonc` (ex. **Sécurité**, **Vault**) apparaissent décochées et peuvent être activées sans éditer le fichier. Un compteur indique les touches de l'accueil (18 au plus, raccourcis compris) ; un choix qui dépasse est refusé sans rien modifier.

**Glisser une case** change l'ordre des rubriques sur l'accueil ; **Ordre par défaut** remet celui de `config.jsonc`.

`config.jsonc` reste la référence (ordre et rubriques par défaut) : seuls les écarts sont enregistrés dans `settings.json` (`"worlds": { "brew": false, "sec": true }`, `"worldOrder": [...]`). Si `config.jsonc` change et que ces écarts ne tiennent plus sur l'accueil, le serveur démarre avec les rubriques du fichier et le signale.

### Voyants

- **K8s** : un clic ouvre la liste des **contextes** et des **namespaces** ; un clic bascule (`kubectl config use-context` / `set-context --current --namespace`). Les contextes et namespaces de production sont en rouge.
- **Git** : un clic ouvre la liste des dépôts ; un clic l'affiche dans le voyant, `>_` ouvre un **nouveau terminal dans ce dépôt**.
- **Conteneurs** : un clic rafraîchit. Tous les voyants se rafraîchissent aussi seuls.

### Terminaux

- **+** ouvre un terminal ; la liste à droite choisit le shell des nouveaux terminaux.
- **Disposition** : 1 terminal (onglets), 2 côte à côte (2×1) ou grille 2×2. Un clic dans un terminal le rend actif (liseré bleu) : c'est lui qui reçoit les touches.
- **Renommer** : double-clic sur le nom d'un onglet. **Déplacer** : glisser un onglet (la grille suit l'ordre des onglets).
- **Activité** : point bleu sur l'onglet d'un terminal caché qui affiche quelque chose, point vert quand une commande longue (plus de 10 s) s'y termine.
- **Notifications** (cloche) : notification du système quand une commande longue se termine dans un terminal caché ou quand la page n'est pas au premier plan.
- **Diffusion** (flèches) : ce que tu tapes, et les touches du deck, partent dans **tous les terminaux visibles** (2×1 ou 2×2), entourés d'orange, avec le bandeau **DIFFUSION → n terminaux**.
- **● REC** : enregistre la session du terminal actif (preuve d'intervention, compte rendu) ; point rouge sur l'onglet, bandeau **● REC**, re-cliquer pour arrêter (arrêt automatique à la fermeture du terminal ou à 50 Mo). Deux fichiers horodatés dans `.deck-recordings/` (hors Git) : `.cast` (rejouable avec `asciinema play`) et `.txt` (texte sans couleurs). Seul ce qui **s'affiche** est enregistré : la frappe non affichée (mot de passe à une invite) et les notes du coffre affichées par le deck n'y figurent pas. Liste et « Ouvrir le dossier » : **Réglages › Enregistrements de sessions** ; **▶** rejoue la session dans le deck (lecture seule, rien n'est envoyé à un shell) : lecture / pause (Espace), barre de progression pour se déplacer, vitesse ×1 à ×8, pauses de plus de 2 s écourtées. En dehors du deck : `asciinema play fichier.cast`.
- **Rechercher** (`⌘F` / `Ctrl+F`, loupe) dans la sortie du terminal actif ; Entrée / Maj+Entrée : suivant / précédent.
- **Taille du texte** : `A−` / `A+`, ou `⌘−` / `⌘+` / `⌘0` (`Ctrl` sous Windows).
- **Copier / coller** : `Cmd+C` / `Cmd+V` sous macOS ; sous Windows, `Ctrl+C` copie la sélection (sans sélection, il interrompt la commande), `Ctrl+V` colle, `Ctrl+Shift+C` / `Ctrl+Shift+V` aussi.
- **Recharger la page** ne coupe pas les terminaux : la fin de leur sortie est rejouée.
- **Redémarrage du serveur** : les terminaux sont rouverts avec leur shell, leur nom, leur ordre et leur dossier de départ (fichier `.deck-sessions.json`) ; les commandes qui tournaient, elles, sont arrêtées.
- Relancer `start.cmd` alors que le deck tourne déjà ouvre simplement la page.

Après une modification de `config.jsonc` ou `paths.json`, redémarrer le serveur.

## Patchs des VMs

Rubrique **Patchs** (à cocher dans Réglages › Rubriques) : inventaire de tes VMs (nom, hôte SSH, clé SSH pour `ssh -i`, environnement, tags libres (`linux, dmz, critique`), description, dernier et prochain patch, fréquence) dans `patches.json` (hors Git, sauvegardé, inclus dans la configuration complète). Le **voyant patchs** affiche la VM la plus urgente (J-3, J, J+2 en retard) : vert, **orange à 7 jours ou moins**, **rouge à J-1, le jour même ou en retard** ; alertes une fois par seuil comme pour les certificats. **Patché** met le dernier patch à aujourd'hui et recalcule le prochain avec la fréquence (noté dans le journal). Touches **ssh VM** et **ssh -i VM** (clé puis hôte, listes réelles) ; bouton **SSH** de l'inventaire avec la clé de la VM si elle est renseignée. Touches de vérification sur la VM après un ssh : mises à jour en attente (apt / dnf), sécurité, redémarrage requis, noyau, historique, correctifs Windows. **Import en masse** depuis un CSV (Excel : séparateur `;`, dates JJ/MM/AAAA ; colonnes nom, hote, cle, environnement, dernier_patch, prochain_patch, frequence, tags, description) avec aperçu avant confirmation (ajout ou mise à jour par nom, jamais de suppression), **export CSV** réimportable et modèle à remplir. **Filtres** de l'inventaire par environnement et par tags (combinés), avec le nombre de VMs. **Vérifier** / **Vérifier tout** : ssh par clé, sans mot de passe (`BatchMode`, clé d'hôte jamais acceptée à ta place), en **lecture seule** : mises à jour en attente dont sécurité (apt, dnf/yum ; zypper, apk), redémarrage requis, OS, noyau ; résultat gardé dans l'inventaire. Détails : [docs/13-patchs.md](docs/13-patchs.md).

**Échéances** (bouton Calendrier, ou ⌘K) : calendrier du mois des prochains patchs et des expirations de certificats, liste du retard et des 60 prochains jours, **export .ics** pour Outlook / Google Agenda (rappel 3 j avant en production, 1 j sinon ; réimporter met à jour sans dupliquer). **Synthèse du client** (⌘K) : état de la mission (contexte kubectl, certificats et VMs par environnement, à traiter, échéances à 30 jours, actions en production des 7 derniers jours), à copier en Markdown ou télécharger. Détails : [docs/14-echeances-et-synthese.md](docs/14-echeances-et-synthese.md).

## Configuration

### `config.jsonc` (commun)

| Clé | Rôle |
|---|---|
| `port` | Port local (défaut 7777). Le serveur n'écoute que sur `127.0.0.1`. |
| `sections` | Rubriques (dossiers) de l'accueil, dans l'ordre. Commenter une ligne avec `//` pour la masquer. |
| `shortcuts` | Raccourcis de l'accueil, placés après les dossiers (18 touches au total). |
| `prodPattern` | Expression régulière : le voyant kubectl passe au rouge si le contexte ou le namespace correspond. |
| `clearKey` | Ajoute la touche `clear` dans les rubriques terminal. |
| `excludeTools` | Masque partout les touches dont la commande commence par cet outil (ex. `crc`, `helm`). |

### `paths.json` (blocs `windows` et `mac`)

| Clé | Rôle |
|---|---|
| `workspace` | Dossier de départ des terminaux, ouvert par la touche VS Code. |
| `gitRoots` | Dossiers où le voyant Git cherche des dépôts (le dossier et ses sous-dossiers directs). |
| `containerCli` / `containerLabel` | Moteur de conteneurs : `["docker"]`, `["podman"]`… |
| `shells` | Shells proposés, le premier trouvé est celui par défaut. Ceux qui n'existent pas sont ignorés. `kind` (`posix`, `powershell`, `cmd`) est déduit du nom de l'exécutable. |
| `apps` | Exécutables (nom cherché dans le PATH, chemin complet, ou liste de candidats : le premier trouvé). |

Pour une machine précise, créer `paths.<nom-de-la-machine>.json` (nom affiché au démarrage) avec seulement les valeurs à changer :

```json
{ "windows": { "workspace": "D:\\dev", "gitRoots": ["D:\\dev"] } }
```

### Paramètres nommés et listes réelles

Une commande de **Mes actions** (ou de `config.jsonc`) peut contenir des paramètres nommés : `kubectl logs -n {namespace} {pod} --since={durée}`. Au clic, une fenêtre demande chaque valeur, avec l'aperçu de la commande, puis la tape (ou la lance si l'action est « exécutée »). Les **dernières valeurs** sont proposées (gardées dans le navigateur, sauf pour les paramètres sensibles : `password`, `token`, `secret`…). Pour `namespace` (`ns`), `pod`, `deployment`, `service`, `node`, `context`, `container` et `image`, la **liste réelle** est lue avec kubectl ou docker ; pods, deployments et services suivent le namespace saisi. Le texte sélectionné dans le terminal (ou dans une note) pré-remplit le premier paramètre. Les touches intégrées **logs -f**, **describe**, **exec -it**, **stern** (K8s) et **logs -f**, **exec -it**, **inspect**, **dive** (Docker) gardent leur fonctionnement avec une sélection ; **sans sélection**, elles ouvrent cette fenêtre avec la liste réelle des namespaces et pods, des conteneurs ou des images. Dans la rubrique **SSH**, **connexion** propose les hôtes de `~/.ssh/config` (paramètre `{host}`, `Include` suivis, motifs comme `Host *` ignorés) ; le fichier est seulement lu. **connexion -i** demande en plus la clé (`ssh -i {identity} {host}`) : clés privées de `~/.ssh` (`%USERPROFILE%\.ssh` sous Windows) repérées par leur `.pub`, un nom classique (`id_rsa`, `id_ed25519`…), l'extension `.pem` / `.key`, ou l'en-tête `-----BEGIN … PRIVATE KEY-----` (seule la première ligne est lue, jamais la clé) ; les clés PuTTY (`.ppk`) ne sont pas proposées (`ssh -i` ne les lit pas : les convertir avec PuTTYgen, « Export OpenSSH key ») ; si aucune clé n'est trouvée, la fenêtre indique le dossier exploré ; l'hôte peut aussi être tapé librement (`user@10.0.0.5`). **tunnel -L** propose les hôtes, avec 8080, localhost et 80 déjà remplis. Dans K8s, **port-forward** demande le namespace, le service puis **ses ports réels** (`kubectl port-forward -n app svc/grafana 3000:3000`).

**Secret dans une commande** : `{secret:Nom du secret}` (nom exact d'un secret du coffre déverrouillé), ex. `docker login -u robot --password-stdin <<< {secret:Harbor robot}`. Au clic, le shell du terminal actif lit le secret **sans écho** dans une variable (`read -rs` sous bash / zsh, `Read-Host -AsSecureString` sous PowerShell, aussi dans un terminal connecté en ssh) : c'est le serveur qui lui transmet la valeur, une fois l'invite affichée. La commande tapée utilise la variable (`"$DECK_SECRET_1"`), effacée juste après (`unset`). La valeur ne passe ni par la page, ni par l'écran, ni par l'historique du shell, ni par le journal, ni par les enregistrements ● REC. Refusé sous cmd et en mode diffusion. Les **noms de secrets sont uniques et sans espace** (ex. `harbor-robot` ; dans le formulaire, un espace devient un tiret ; majuscules ignorées pour comparer) : un doublon est refusé à l'enregistrement, renommé `nom-importe` à la fusion d'un coffre ; si un ancien coffre en contient encore, la commande demande d'en renommer un plutôt que de deviner.

Un paramètre peut avoir une **valeur par défaut** : `{durée=15m}`, `{local=8080}` (champ pré-rempli, modifiable).

La liste s'ouvre dès qu'on clique dans un champ, filtrée par ce qu'on tape (sans casse ni accents) ; clic, ou ↑ ↓ puis Entrée pour choisir, puis Entrée pour taper la commande. Un namespace sans pod est signalé.

### Mes actions (depuis le deck)

**Réglages › Mes actions** : **Nouvelle rubrique…** (nom, icône, couleur), puis **+ Action** dans la rubrique : une **commande** (exécutée tout de suite, ou à compléter ; `{}` = texte sélectionné dans le terminal) ou un **lien**, avec un nom, une icône (vide = automatique) et une infobulle. Flèches pour l'ordre, Modifier, Supprimer (deux clics). Une rubrique créée s'affiche sur l'accueil si elle y tient (sinon : la cocher dans « Rubriques » après en avoir décoché une). Tout est enregistré dans `actions.json`, **hors Git** (les commandes propres à un client ne partent pas sur le dépôt), et sauvegardé automatiquement. Une erreur (commande sur plusieurs lignes, lien non http(s), icône inconnue…) s'affiche dans le formulaire sans perdre la saisie.

Une action peut être **épinglée sur l'accueil** (case du formulaire), en plus de sa rubrique, dans la limite des 18 touches : un dépassement est refusé sans rien modifier.

**Partager une rubrique** : **Exporter** (sur la rubrique) crée `rubrique-<nom>.json` ; un collègue l'ajoute avec **Importer une rubrique…**, après avoir vu la liste des commandes (en vert, celles qui s'exécutent dès le clic). Tout est revalidé comme une saisie, rien n'est épinglé, un nom déjà pris devient « (importée) ». Les `{mission.…}` restent tels quels : chacun utilise les valeurs de sa mission.

### Tes propres rubriques et touches (`config.jsonc`)

Sans toucher au code : `customSections` (rubriques) et `customShortcuts` (raccourcis de l'accueil), puis ajouter leur identifiant dans `sections` / `shortcuts`.

```jsonc
"customSections": {
    "perso": {
        "label": "Perso", "icon": "lucide-star", "color": "#607D8B",
        "keys": [
            { "label": "mes alias", "icon": "lucide-list", "command": "alias", "enter": true },
            { "label": "port-forward", "icon": "lucide-arrow-left-right", "command": "kubectl port-forward {} 8080:80" },
            { "label": "Grafana", "icon": "grafana", "url": "https://grafana.example.com" }
        ]
    }
}
```

`command` peut avoir des variantes par système (`{ "windows": …, "mac": … }`) et/ou par shell (`{ "posix": …, "powershell": …, "cmd": … }`). `enter: true` exécute (pastille verte), sinon la commande est seulement tapée. Icônes : `lucide-<nom>` ([lucide.dev/icons](https://lucide.dev/icons)) ou un logo ([simpleicons.org](https://simpleicons.org), ex. `github`). L'accueil a 18 cases au total.

### Ajouter une rubrique ou une touche (dans le code)

Dans `server/catalog.mjs`, ajouter un bloc à `sections` (14 touches max), puis l'activer dans `config.jsonc`. Une commande peut différer selon le système :

```js
text("secret aléa", "🎲", { windows: "openssl rand -base64 32 | clip", mac: "openssl rand -base64 32 | pbcopy" }, true, C.tool)
```

Si la syntaxe dépend du shell, utiliser `sh(posix, powershell, cmd)` (seul ou dans une variante par système) :

```js
text("VAULT_ADDR", "🌐", sh('export VAULT_ADDR="http://127.0.0.1:8200"', '$env:VAULT_ADDR="http://127.0.0.1:8200"', "set VAULT_ADDR=http://127.0.0.1:8200"), false, C.tool)
```

Types de touches : `text` (tape dans le terminal), `web` (ouvre un onglet), `run` (lance un programme sur la machine), `status` (voyant).

## Tests

Ils tournent aussi sur **GitHub Actions** à chaque push, sur Windows, macOS et Linux (`.github/workflows/tests.yml`).

`npm test` lance les tests automatiques (`test/`, lanceur intégré à Node 22 ou plus, sans dépendance) en moins d'une seconde : favoris (ajout, groupes, glisser-déposer, import), coffre (chiffrement, notes en couleur, export / import), réglages (validation, ancien format), sauvegardes, catalogue (limite de l'accueil, rubriques, descriptions, garde-fou production) et détection ssh / wsl. Ils travaillent dans des dossiers temporaires : les vrais favoris, coffre et réglages ne sont jamais touchés. À lancer avant chaque commit.

## Différences avec la version Stream Deck

- Les commandes sont tapées dans le **terminal intégré**, pas dans la fenêtre active : un navigateur ne peut pas envoyer de frappes à une autre application.
- Pour la même raison, la rubrique **VS Code** utilise la CLI `code` (`code .`, `code -g fichier:ligne`, `code --diff`…) au lieu des raccourcis de l'éditeur. Le dossier de la CLI est ajouté au PATH des terminaux s'il manque.
- Les emojis s'affichent en couleur, avec les polices du navigateur.

## Sécurité

Le terminal donne un shell complet : l'accès est verrouillé.

- Le serveur n'écoute que sur `127.0.0.1`.
- Un **jeton** aléatoire (fichier `.deck-token`, non versionné) est demandé dans l'URL de démarrage, puis échangé contre un cookie `HttpOnly`, `SameSite=Strict`, propre au port (`deck_token_7777` : un second deck sur la même machine ne l'écrase pas), gardé 400 jours et prolongé à chaque ouverture (l'application installée s'ouvre directement). Supprimer `.deck-token` en génère un nouveau au démarrage suivant.
- L'en-tête `Host` est vérifié (protection contre le DNS rebinding), ainsi que l'`Origin` des WebSockets (une autre page ouverte dans le navigateur ne peut pas s'y connecter).
- Le navigateur n'envoie que l'identifiant d'une touche `run` : le serveur ne lance que les commandes de son catalogue.
- La page interdit l'affichage dans une iframe et applique une Content-Security-Policy stricte.

## Mise à jour et configuration d'une machine à l'autre

- **Mise à jour en un clic** (Réglages › Serveur) : le deck compare sa version avec GitHub au démarrage puis toutes les 6 h (ou avec **Vérifier**) ; une pastille sur l'engrenage signale une nouvelle version. **Mettre à jour** (deux clics) fait `git pull`, installe les dépendances si besoin et redémarre. Refusé si des fichiers suivis par Git ont été modifiés sur la machine (ex. `config.jsonc`), pour ne rien écraser. Après un redémarrage avec une nouvelle version, les onglets déjà ouverts **se rechargent tout seuls** à la reconnexion (sinon ils garderaient l'ancien code de la page).
- **Configuration complète** (Réglages) : **Exporter…** un seul fichier avec favoris, Mes actions, réglages et missions, signature ; sur l'autre machine, **Importer…** en choisissant les parties (favoris fusionnés ou remplacés). Chaque fichier remplacé est sauvegardé avant ; les dossiers de mission absents de la machine sont signalés. Le coffre s'exporte à part (son import demande le mot de passe maître).

## Vérifier sous Windows

1. **Réglages › Serveur › Diagnostic** : presse-papiers, détection ssh / wsl, outils (Scoop), sauvegardes, shells, et **réseau** : proxy détecté (`HTTPS_PROXY`, `NO_PROXY`, identifiants masqués), DNS d'un nom public, accès HTTPS (direct ou via le proxy, avec l'émetteur du certificat : un TLS déchiffré par le proxy, ex. Zscaler, est signalé), accès Git pour **Mettre à jour** ; chaque ligne dit ce qui fonctionne ou non.
2. **Service** : double-clic sur `service\installer.cmd` ; fermer toutes les fenêtres, puis vérifier que le deck répond toujours ; **Réglages › Serveur** doit afficher « Lancé en service Windows ». Redémarrer la session : le deck doit démarrer seul.
3. **Redémarrer le deck** (Réglages › Serveur) : la page se reconnecte en quelques secondes.
4. **Ansible** : touches grisées ; `ssh` vers une machine Linux dans le terminal → badge **SSH** sur l'onglet, touches actives ; `exit` → grisées à nouveau.
5. **Coffre › Copier** : coller ailleurs (`Ctrl+V`), puis après 30 s le presse-papiers est vide.
6. **Outils à installer** : clic sur une touche grisée → `scoop install …` tapé ; après l'installation, la touche se rallume.

## Dépannage

- **Une adresse `?token=…` a pu fuiter** (capture, message, autre poste) : **Réglages › Serveur › Renouveler le jeton** (deux clics). L'ancien jeton ne fonctionne plus nulle part, les autres navigateurs sont déconnectés ; la page qui renouvelle bascule seule sur le nouveau (le fichier `.deck-token` est mis à jour).
- **Le deck s'arrête tout seul** : lancé avec `start.command` / `start.cmd`, fermer sa fenêtre l'arrête. Installer le service (voir *Lancement automatique*) ; en cas de plantage, le journal du service en donne la cause.
- **« Accès refusé »** : la page affiche la commande à lancer une fois (Terminal sur Mac, PowerShell sous Windows) pour rouvrir le deck avec son adresse complète (`?token=…`) ; ensuite l'application installée s'ouvre directement.
- **Un outil est « introuvable »** au démarrage alors qu'il marche dans un terminal : indiquer son chemin complet dans `paths.<machine>.json`.
- **Un voyant affiche « erreur »** : lancer la même commande dans le terminal intégré pour voir le message (`kubectl config current-context`, `git status`, `docker ps`).
- **Le port 7777 est pris** par un autre programme : changer `port` dans `config.jsonc`.
