# Dépannage

[← Sommaire](README.md)

Commence toujours par **Réglages › Serveur › Diagnostic** : chaque ligne dit ce qui fonctionne ou non
(voir [Diagnostic](10-reglages-et-tracabilite.md#diagnostic)).

| Problème | Solution |
|---|---|
| **Connecté en ssh, mais pas de cadre et touches des VMs grisées** | **Réglages › Serveur › Diagnostic** pendant que le terminal est connecté, ligne **Terminaux connectés** : « surveillance ARRÊTÉE » (le PowerShell de surveillance a été coupé, par un antivirus par exemple ; il est relancé seul, l'erreur s'affiche), ou « NON détecté » avec la lignée du ssh et la raison. Envoie cette ligne pour analyse. |
| **« Accès refusé »** (navigateur ou application installée) | Le navigateur n'a pas, ou plus, le jeton : premier lancement, jeton renouvelé, cookies effacés. La page affiche la commande à lancer une fois (Terminal sur Mac, PowerShell sous Windows) pour rouvrir le deck avec son adresse complète ; ensuite l'application s'ouvre directement. |
| **Le deck s'arrête tout seul** | Lancé avec `start.command` / `start.cmd`, fermer sa fenêtre l'arrête : installe le service (voir [Prise en main](01-prise-en-main.md)). |
| **Une adresse `?token=…` a fuité** | Réglages › Serveur › **Renouveler le jeton** : l'ancien ne fonctionne plus nulle part. |
| **Un onglet affiche l'ancienne version** | Il se recharge seul à la reconnexion ; sinon `⌘R`. |
| **Un outil est « introuvable »** alors qu'il marche dans un terminal | Indique son chemin complet dans `paths.<machine>.json`. |
| **Un voyant affiche « erreur »** | Lance la même commande dans le terminal (`kubectl config current-context`, `git status`, `docker ps`) pour voir le message. |
| **Certificat « injoignable »** | Le poste n'atteint pas le serveur (réseau, VPN) ; derrière un proxy, définis `HTTPS_PROXY` puis redémarre le deck (voir [Missions et certificats](08-missions-et-certificats.md#poste-dentreprise-et-proxy)). |
| **Mettre à jour échoue** | Diagnostic › Accès Git ; derrière un proxy : `git config --global http.proxy <url du proxy>`. Refusé aussi si des fichiers suivis ont été modifiés sur la machine. |
| **Aucune clé dans connexion -i** | La fenêtre indique le dossier exploré ; une clé PuTTY (`.ppk`) doit être convertie (PuTTYgen, *Export OpenSSH key*). |
| **`{secret:…}` refusé** | Coffre verrouillé, nom inexact ou en double, terminal `cmd`, ou diffusion active : le message dit lequel. |
| **Le port 7777 est pris** | Change `port` dans `config.jsonc`. |

## Vérifier sous Windows

1. **Diagnostic** : presse-papiers, détection ssh / wsl, outils (Scoop), réseau et proxy.
2. **Service** : `service\installer.cmd`, fermer toutes les fenêtres, le deck doit toujours répondre ; Réglages ›
   Serveur affiche « Lancé en service Windows ».
3. **Ansible** : grisé, puis actif après un `ssh` vers une machine Linux dans le terminal.
4. **Coffre › Copier** : coller ailleurs, puis après 30 s le presse-papiers est vide.
