# Missions et certificats

[← Sommaire](README.md)

## Un profil par client

![Formulaire de mission](img/mission-formulaire.jpg)

**Réglages › Missions › Nouvelle mission…** enregistre un profil :

- **thème** aux couleurs du client, **rubriques affichées et leur ordre** ;
- **motif de production** (voyant kubectl rouge, garde-fous ; vide = `prodPattern` de `config.jsonc`) ;
- **dossier des nouveaux terminaux** et **groupe de favoris** ouvert par la touche Favoris ;
- **variables** (`registry = harbor.client.fr`), utilisables dans les commandes : `{mission.registry}` ;
- **certificats à surveiller**.

Le sélecteur **Mission** de l'en-tête l'active en un clic. Tant qu'une mission est active, ce que tu changes dans
**Rubriques** et le thème est enregistré dans la mission : la réactiver ne fait pas revenir les anciennes rubriques.
Les missions sont dans `settings.json`, hors Git.

## Surveillance des certificats

![Certificats](img/certificats.jpg)

Dans la mission, une adresse par ligne (`api.client.fr`, `ldap.client.fr:636` ; une URL complète est acceptée). Le
voyant **certificats**, première touche de la rubrique **OpenSSL** (ou `cert-status` sur l'accueil via `config.jsonc`),
affiche le certificat qui expire le plus tôt :

| Couleur | Signification |
|---|---|
| 🟢 vert | plus de 30 jours |
| 🟠 orange | moins de 30 jours |
| 🔴 rouge | moins de 7 jours, ou expiré |
| ⚪ gris | aucun certificat suivi, ou serveurs injoignables |

- **Clic** : la liste de tous les certificats (jours restants, date, **émetteur**, chaîne non reconnue, serveur
  injoignable avec la raison en clair), et **Vérifier maintenant**. Sinon, vérification toutes les 30 min.
- **Alerte** au passage à l'orange puis au rouge : message dans le deck et notification du système (si autorisée avec
  la cloche des terminaux), une seule fois par seuil.
- La date est lue par une simple poignée de main TLS (Node, sans openssl, 10 s au plus). Rien d'autre n'est envoyé.

## Poste d'entreprise et proxy

Sur un réseau où toute sortie passe par un proxy (ex. Zscaler) et où le DNS interne ne résout pas les noms publics :

- définis `HTTPS_PROXY` pour ton utilisateur (`setx HTTPS_PROXY http://proxy:8080` sous Windows), puis redémarre le deck ;
- la vérification passe alors par un tunnel `CONNECT` du proxy ; `NO_PROXY` est respecté ;
- si le proxy **déchiffre le TLS**, le certificat vu est celui du proxy : la ligne est marquée ⚠ et ne compte pas
  pour la couleur ;
- erreurs distinguées : nom inconnu du DNS, proxy injoignable, refus du proxy (403, 407, 502…), délai dépassé.

Le [diagnostic](10-reglages-et-tracabilite.md#diagnostic) vérifie tout cela en un clic.
