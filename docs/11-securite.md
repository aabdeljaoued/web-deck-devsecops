# Sécurité

[← Sommaire](README.md)

Le deck donne un shell complet et garde des secrets : l'accès est verrouillé, et les données restent sur ton poste.

## Accès au deck

- Le serveur n'écoute que sur `127.0.0.1` : aucune autre machine ne peut s'y connecter.
- Un **jeton** aléatoire (`.deck-token`, hors Git) est demandé dans l'adresse de démarrage, puis échangé contre un
  cookie `HttpOnly`, `SameSite=Strict`, propre au port du deck (un autre deck sur la même machine ne peut pas
  l'écraser) et gardé 400 jours (prolongé à chaque ouverture) pour que l'application installée s'ouvre directement. **Renouveler le jeton** (Réglages › Serveur) l'invalide partout s'il a fuité.
- L'en-tête `Host` est vérifié (protection contre le DNS rebinding), ainsi que l'`Origin` des WebSockets : une autre
  page ouverte dans le navigateur ne peut pas s'y connecter.
- La page refuse d'être affichée dans une iframe et applique une Content-Security-Policy stricte.
- Les touches « exécutées » n'envoient que leur identifiant : le serveur ne lance que les commandes de son catalogue.

## Secrets

- Coffre chiffré **AES-256-GCM**, clé dérivée du mot de passe maître avec **scrypt** ; verrouillage automatique
  (15 min, et au verrouillage de l'écran du poste).
- **Copier** passe par le presse-papiers du système, écrit par le serveur et **effacé après 30 s** : la valeur ne
  transite pas par la page.
- **`{secret:nom}`** dans une commande : lu par le shell sans écho, la valeur ne passe ni par la page, ni par l'écran,
  ni par l'historique, ni par le journal, ni par les enregistrements.
- Les paramètres sensibles (`password`, `token`, `secret`…) ne sont jamais gardés dans l'historique de saisie.

## Garde-fous

- Production signalée partout (bord rouge, voyant, bandeau) ; actions sensibles et changement de contexte vers la
  production **confirmés par un second clic** ; **diff** proposé avant d'appliquer (voir
  [Kubernetes et production](03-kubernetes-et-production.md)).
- **Mode partage d'écran** pour les réunions (voir [Réglages](10-reglages-et-tracabilite.md#mode-partage-décran)).

## Données hors Git

Favoris, coffre, réglages et missions, Mes actions, journal, enregistrements, sauvegardes et signature sont exclus du
dépôt (`.gitignore`) : les informations d'un client ne partent jamais sur GitHub.
