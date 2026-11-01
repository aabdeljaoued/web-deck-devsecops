# Web Deck DevSecOps

Le deck DevSecOps dans le navigateur, **sans Stream Deck ni droits administrateur** : une grille de touches (Git, Kubernetes, Docker, Helm, Terraform, Brew / Scoop, SSH, OpenSSL, veille sécurité…), des voyants en direct (contexte kubectl, branche Git, conteneurs) et un **vrai terminal intégré** (PowerShell, Git Bash, cmd ou zsh) dans lequel les touches tapent leurs commandes.

```
config.jsonc   QUOI afficher : rubriques, raccourcis, outils exclus, port
paths.json     OÙ sont les logiciels et les shells, par système (paths.<machine>.json fusionné par-dessus)
server/        serveur Node.js : pages, terminaux (node-pty), voyants, lanceurs
public/        page web : grille + terminal (xterm.js), sans étape de build
start.cmd      lanceur Windows (double-clic)
start.command  lanceur macOS (double-clic dans le Finder)
start.sh       lanceur macOS / Linux en ligne de commande
```

## Installation sous Windows sans droits admin

1. **Node.js** (20 ou plus), au choix :
   - **portable** : télécharger le zip « Windows Binary (.zip) » x64 sur [nodejs.org](https://nodejs.org/en/download), l'extraire dans un dossier `node` **à la racine du projet** (`node\node.exe`). `start.cmd` l'utilise automatiquement ;
   - ou `winget install OpenJS.NodeJS.LTS --scope user` si winget est autorisé ;
   - ou via [Scoop](https://scoop.sh) (installation utilisateur) : `scoop install nodejs-lts`.
2. **Récupérer le projet** (git clone ou zip), puis double-cliquer sur **`start.cmd`**. Au premier lancement, il installe les dépendances (`npm install`), démarre le serveur et ouvre le navigateur.

Aucune compilation n'est nécessaire : `node-pty` embarque ses binaires pour Windows (x64, ARM64) et macOS (Intel, Apple Silicon).

Shells détectés sous Windows : PowerShell 7 (`pwsh`), Windows PowerShell, Git Bash (installation système, utilisateur ou Scoop) et cmd.

## Installation sous macOS

1. **Node.js** (20 ou plus) : `brew install node`, ou l'archive macOS (`.tar.gz`) de [nodejs.org](https://nodejs.org/en/download) extraite dans un dossier `node` à la racine du projet (`node/bin/node`).
2. Double-cliquer sur **`start.command`** dans le Finder (ou `./start.sh` dans un terminal). Fermer la fenêtre Terminal arrête le deck.
   Si le projet vient d'un zip téléchargé, macOS peut bloquer le lanceur : clic droit › Ouvrir, ou `xattr -dr com.apple.quarantine .` dans le dossier.

Sans les outils de ligne de commande Xcode, `git` est considéré comme absent (sinon macOS ouvrirait une fenêtre d'installation à chaque rafraîchissement du voyant) : `xcode-select --install`.

La touche **Verrouiller** met l'écran en veille (`pmset displaysleepnow`) : elle ne verrouille que si *Réglages Système › Écran verrouillé › Exiger un mot de passe* est réglé sur « Immédiatement ».

Linux fonctionne aussi (`./start.sh`) : sans bloc `linux` dans `paths.json`, celui de `mac` est utilisé.

## Utilisation

- **Pastille verte** : la commande est tapée **et exécutée** dans le terminal actif.
- **Pastille orange** : la commande est seulement tapée, tu complètes ou valides toi-même (commandes à compléter ou risquées).
- **Clear** est toujours en bas à gauche des rubriques, **Verrouiller** toujours en bas à droite.
- **+** ouvre un nouvel onglet de terminal ; la liste à droite choisit le shell des nouveaux onglets.
- Les touches tapent la variante adaptée au shell de l'onglet actif (ex. `$env:VAULT_ADDR=` dans PowerShell, `export VAULT_ADDR=` dans bash/zsh, `set VAULT_ADDR=` dans cmd). Une touche sans variante pour ce shell affiche un message.
- **Copier / coller** : `Cmd+C` / `Cmd+V` sous macOS ; sous Windows, `Ctrl+C` copie la sélection (sans sélection, il interrompt la commande), `Ctrl+V` colle, `Ctrl+Shift+C` / `Ctrl+Shift+V` aussi.
- Les **voyants** se rafraîchissent seuls ; un clic les rafraîchit tout de suite (Git : dépôt suivant).
- **Recharger la page** ne coupe pas les terminaux : la fin de leur sortie est rejouée. Les terminaux s'arrêtent avec le serveur (Ctrl+C dans sa fenêtre).
- Relancer `start.cmd` alors que le deck tourne déjà ouvre simplement la page.

Après une modification de `config.jsonc` ou `paths.json`, redémarrer le serveur.

## Configuration

### `config.jsonc` (commun)

| Clé | Rôle |
|---|---|
| `port` | Port local (défaut 7777). Le serveur n'écoute que sur `127.0.0.1`. |
| `sections` | Rubriques (dossiers) de l'accueil, dans l'ordre. Commenter une ligne avec `//` pour la masquer. |
| `shortcuts` | Raccourcis de l'accueil, placés après les dossiers (15 touches au total). |
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

### Ajouter une rubrique ou une touche

Dans `server/catalog.mjs`, ajouter un bloc à `sections` (14 touches max), puis l'activer dans `config.jsonc`. Une commande peut différer selon le système :

```js
text("secret aléa", "🎲", { windows: "openssl rand -base64 32 | clip", mac: "openssl rand -base64 32 | pbcopy" }, true, C.tool)
```

Si la syntaxe dépend du shell, utiliser `sh(posix, powershell, cmd)` (seul ou dans une variante par système) :

```js
text("VAULT_ADDR", "🌐", sh('export VAULT_ADDR="http://127.0.0.1:8200"', '$env:VAULT_ADDR="http://127.0.0.1:8200"', "set VAULT_ADDR=http://127.0.0.1:8200"), false, C.tool)
```

Types de touches : `text` (tape dans le terminal), `web` (ouvre un onglet), `run` (lance un programme sur la machine), `status` (voyant).

## Différences avec la version Stream Deck

- Les commandes sont tapées dans le **terminal intégré**, pas dans la fenêtre active : un navigateur ne peut pas envoyer de frappes à une autre application.
- Pour la même raison, la rubrique **VS Code** utilise la CLI `code` (`code .`, `code -g fichier:ligne`, `code --diff`…) au lieu des raccourcis de l'éditeur. Le dossier de la CLI est ajouté au PATH des terminaux s'il manque.
- Les emojis s'affichent en couleur, avec les polices du navigateur.

## Sécurité

Le terminal donne un shell complet : l'accès est verrouillé.

- Le serveur n'écoute que sur `127.0.0.1`.
- Un **jeton** aléatoire (fichier `.deck-token`, non versionné) est demandé dans l'URL de démarrage, puis échangé contre un cookie `HttpOnly`, `SameSite=Strict`. Supprimer `.deck-token` en génère un nouveau au démarrage suivant.
- L'en-tête `Host` est vérifié (protection contre le DNS rebinding), ainsi que l'`Origin` des WebSockets (une autre page ouverte dans le navigateur ne peut pas s'y connecter).
- Le navigateur n'envoie que l'identifiant d'une touche `run` : le serveur ne lance que les commandes de son catalogue.
- La page interdit l'affichage dans une iframe et applique une Content-Security-Policy stricte.

## Dépannage

- **« Accès refusé »** : ouvrir l'adresse complète affichée dans la fenêtre du serveur (avec `?token=…`).
- **Un outil est « introuvable »** au démarrage alors qu'il marche dans un terminal : indiquer son chemin complet dans `paths.<machine>.json`.
- **Un voyant affiche « erreur »** : lancer la même commande dans le terminal intégré pour voir le message (`kubectl config current-context`, `git status`, `docker ps`).
- **Le port 7777 est pris** par un autre programme : changer `port` dans `config.jsonc`.
