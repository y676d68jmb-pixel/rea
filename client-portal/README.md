# Portail client

Site web où chaque client se connecte avec **son identifiant et son mot de passe** pour suivre :

- l'**état d'avancement de ses dossiers** (état + pourcentage),
- l'**état de ses factures** (à payer, payée, en retard, annulée),
- les **tâches** : il en dépose pour le cabinet, et il voit celles que le cabinet lui demande,
- l'**historique complet** de ses dossiers, mis à jour automatiquement à chaque changement.

Le cabinet (administrateur) crée les comptes clients, les dossiers et les factures, met à jour l'avancement et traite les tâches.

Aucune dépendance externe : il faut seulement **Node.js 22.13 ou plus récent**. Les données sont stockées dans un fichier SQLite (`data/portail.db`).

## Démarrage

```bash
cd client-portal
npm run create-admin -- admin "Mon cabinet"   # affiche un mot de passe provisoire
npm start                                     # http://127.0.0.1:3000
```

1. Connectez-vous avec `admin` et le mot de passe provisoire, puis choisissez votre propre mot de passe.
2. Dans **Clients**, créez un client : un identifiant `CL-0001` et un mot de passe provisoire s'affichent **une seule fois**. Transmettez-les au client.
3. À sa première connexion, le client doit choisir son propre mot de passe.

Un mot de passe oublié se réinitialise depuis la fiche du client (bouton **Réinitialiser le mot de passe**). Pour l'administrateur, relancez `npm run create-admin -- admin`.

## Configuration

| Variable        | Rôle                                                               | Défaut             |
| --------------- | ------------------------------------------------------------------ | ------------------ |
| `PORT`          | Port d'écoute                                                      | `3000`             |
| `HOST`          | Adresse d'écoute                                                   | `127.0.0.1`        |
| `DATABASE_FILE` | Fichier de la base de données                                      | `data/portail.db`  |
| `SITE_NAME`     | Nom affiché en haut des pages                                      | `Espace client`    |
| `CURRENCY`      | Devise des factures (code ISO)                                     | `TND`              |
| `TIME_ZONE`     | Fuseau horaire des dates                                           | `Africa/Tunis`     |
| `NODE_ENV`      | `production` active les cookies sécurisés (HTTPS obligatoire)      | —                  |
| `TRUST_PROXY`   | `1` si le site est derrière un proxy (Nginx, Caddy…)               | —                  |

## Mise en ligne

Le site doit être servi en **HTTPS**. Configuration conseillée sur un petit serveur (VPS) :

1. Lancer l'application avec `NODE_ENV=production TRUST_PROXY=1 npm start` (par exemple via un service systemd ou pm2).
2. Mettre un proxy HTTPS devant, par exemple Caddy, qui obtient le certificat automatiquement :
   ```
   portail.mon-cabinet.tn {
       reverse_proxy 127.0.0.1:3000
   }
   ```
3. **Sauvegarder régulièrement** le dossier `data/`, qui contient toutes les données.

## Sécurité

- Mots de passe hachés avec scrypt, jamais stockés en clair ; 10 caractères minimum.
- Mot de passe provisoire à changer obligatoirement à la première connexion.
- Blocage temporaire après 5 échecs de connexion (15 minutes).
- Sessions de 12 h dans des cookies `HttpOnly` / `SameSite` ; changer ou réinitialiser un mot de passe déconnecte les autres appareils.
- Protection CSRF sur tous les formulaires, en-têtes de sécurité (CSP, anti-iframe).
- Chaque client ne voit que ses propres données ; les pages d'administration lui sont invisibles.
- Un compte client peut être désactivé à tout moment.

## Tests

```bash
npm test
```

## Pistes d'évolution

- Dépôt de fichiers (pièces justificatives, factures PDF).
- Notifications par e-mail (nouvelle facture, dossier mis à jour, tâche déposée).
- Plusieurs utilisateurs côté cabinet, avec leurs propres droits.
