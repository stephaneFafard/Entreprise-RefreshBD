# Refresh Local BD

Liste les bases MariaDB locales et permet de les mettre à jour à partir de la production.

## Démarrage

Double-cliquer sur **`Start.bat`** : il installe les dépendances au besoin, crée `.env`,
démarre MariaDB (XAMPP, `C:\xampp`) si elle ne tourne pas, lance le serveur et ouvre le navigateur.

Ou manuellement :

```bash
npm install
cp .env.example .env   # puis renseigner LOCAL_DB_PASSWORD
npm start              # http://localhost:3100
```

## Fonctionnement

- À l'ouverture, l'interface scanne la MariaDB locale (`SHOW DATABASES`, sans les bases système).
- Chaque ligne affiche une case à cocher, le nom de la BD et la date de dernière synchronisation.
- Les dates de synchronisation sont conservées dans `data/sync-history.json`.
- Le bouton **Synchroniser** remplace les bases cochées par celles de la production.

## Synchronisation

Configurer la section « Serveur de production » de `.env` (`SSH_HOST`, `SSH_USER`, clé ou mot de passe,
`PROD_DB_PREFIX`). Pour chaque base sélectionnée :

1. Connexion SSH au cPanel, `mysqldump | gzip` de la base de production, téléchargé dans `data/tmp`.
   Le mot de passe MySQL est envoyé par stdin, jamais en ligne de commande.
   Le dump doit se terminer par `-- Dump completed`, sinon la base locale n'est pas touchée.
2. Sauvegarde de la base locale dans `data/backups` (les `BACKUP_KEEP` dernières sont conservées).
3. Suppression / recréation de la base locale puis import du dump, adapté pour MariaDB 10.4
   (collations MySQL 8, `DEFINER`, GTID). En cas d'échec, la sauvegarde est réimportée.

Nom en production = `PROD_DB_PREFIX` + nom local (sauf si le nom local a déjà le préfixe), comparé
sans tenir compte des majuscules (la MariaDB locale sous Windows met les noms en minuscules).
Quand les noms diffèrent, ajouter une correspondance : `PROD_DB_MAP=appscout_db:clubinio_appscout,...`.
Les bases sans équivalent en production sont affichées mais ne peuvent pas être cochées.
