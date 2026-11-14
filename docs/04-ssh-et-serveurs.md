# SSH et serveurs

[← Sommaire](README.md)

![Hôtes SSH](img/ssh-hotes.jpg)

## Se connecter

- **connexion** : liste des hôtes de ton `~/.ssh/config` (lignes `Host`, `Include` suivis, motifs comme `Host *`
  ignorés). Le fichier est seulement lu. Tu peux aussi taper une adresse (`user@10.0.0.5`).
- **connexion -i** : choisis d'abord la **clé**, puis l'hôte → `ssh -i <clé> <hôte>`. Les clés privées de `~/.ssh`
  (`%USERPROFILE%\.ssh` sous Windows) sont reconnues par leur `.pub`, un nom classique (`id_ed25519`, `id_rsa`…),
  l'extension `.pem` / `.key`, ou leur en-tête `-----BEGIN … PRIVATE KEY-----` (seule cette première ligne est lue,
  jamais la clé). Les clés PuTTY (`.ppk`) ne sont pas proposées : `ssh -i` ne les lit pas (convertis-les avec
  PuTTYgen, *Export OpenSSH key*).
- **tunnel -L** : hôte, port local, cible et port distant (8080, localhost et 80 pré-remplis).

Si tu utilises toujours la même clé pour un hôte, écris-la une fois dans `~/.ssh/config` (`IdentityFile`) :
**connexion** suffit alors.

## Savoir sur quelle machine on tape

![Terminal connecté à une VM de production](img/ssh-vm-connectee.jpg)

Dès qu'un terminal est connecté en **ssh** (ou **wsl**), le deck affiche la machine :

- **un cadre de couleur** autour du terminal : **rouge** si la VM est en **production**, bleu sinon ;
- **une étiquette accrochée en haut du cadre** : « SSH · app-prod-01 · production » (en vue partagée, 2 ou 4
  terminaux : « zsh 2 · web-recette-01 » dans le coin de chaque écran) ;
- **sur l'onglet** : le nom de la **VM de l'inventaire** ([Patchs](13-patchs.md)) si l'hôte y figure, sinon le nom
  de l'hôte, dans la même couleur ; au survol, la destination complète.

![Deux terminaux connectés, vue partagée](img/ssh-vm-partage.jpg)

La VM est reconnue par son hôte (`admin@app-prod-01.client.fr`), son nom d'hôte sans utilisateur, son nom court ou
son nom d'inventaire (alias de `~/.ssh/config` du même nom). Seule la destination est lue dans la commande ssh : ni
la clé, ni les options, ni la commande distante. À la déconnexion (`exit`), l'onglet redevient local.

**Bastion (CyberArk PSMP…)** : avec une destination `compte@utilisateur_cible@vm_cible@bastion`, c'est la **VM cible**
qui est affichée et rapprochée de l'inventaire, avec la mention « via bastion » (le bastion au survol de l'onglet).

**Git Bash (Windows)** : le processus intermédiaire entre bash et ssh disparaît, le ssh n'a plus de parent visible
pour Windows ; le deck retrouve sa filiation dans la table de processus de Git Bash (`ps.exe` fourni avec Git) et le
rattache au bon terminal (« filiation Git Bash » dans le diagnostic). Comptez 2 à 5 secondes après la connexion.

Si le cadre n'apparaît pas, **Réglages › Serveur › Diagnostic**, ligne **Terminaux connectés**, terminal connecté :
elle dit si la surveillance tourne, et pour chaque ssh vu, sa lignée de processus et pourquoi il est (ou non)
rattaché au terminal.

## Les autres touches

Clés (`ssh-keygen`, copier la clé publique, empreinte), agent (`ssh-add`), `ssh -T git@github.com`, `ssh-keyscan`,
oublier un hôte (`ssh-keygen -R`), éditer `~/.ssh/config`, audit (`ssh-audit`).

## Ansible sous Windows

Ansible ne tourne pas sous Windows. La rubrique **Ansible** y est grisée, puis **s'active toute seule** quand le
terminal actif est connecté en **ssh** à une machine Linux / macOS (ou ouvert dans **wsl**).
