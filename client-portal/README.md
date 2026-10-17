# Portail client — déclarations en douane

Site web où chaque client importateur ou exportateur se connecte avec **son identifiant et son mot de passe** pour suivre ses dossiers de dédouanement :

- **Avancement de chaque dossier** import ou export, étape par étape : documents, domiciliation bancaire, arrivée ou réservation du transport, déclaration, contrôle de la douane, droits et taxes, bon à enlever (BAE), sortie du port ou embarquement, livraison.
- **Douane** : n° de déclaration, circuit (vert, orange, rouge), date et lieu de visite, contrôle technique (AMC, APE, D41), montant des droits et taxes et qui les paie.
- **Documents** : ce que le client doit fournir (avec un bouton « Je l'ai envoyé »), ce qui est attendu d'autres intervenants, et ce que le cabinet lui remettra (déclaration, BAE, quittance, facture visée).
- **À faire** : une seule liste avec tout ce que le client doit faire (documents, demandes du cabinet, provisions et factures à régler, droits à payer).
- **Factures et provisions** : honoraires et frais avec TVA, débours sans TVA avec leur justificatif, timbre fiscal, provisions déduites de la facture finale.
- **Historique** complet, alimenté automatiquement à chaque changement.

Le cabinet (administrateur) crée les comptes clients et les dossiers, fait avancer les étapes, vérifie les documents et émet les factures. La page **Dossiers** liste les dossiers bloqués ou en attente en premier ; la page **À traiter** regroupe les documents signalés envoyés par les clients et leurs demandes.

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
| `DOCUMENTS_HINT` | Phrase indiquant au client comment transmettre ses documents     | e-mail ou bureau   |
| `CURRENCY`      | Devise des factures (code ISO)                                     | `TND`              |
| `TIME_ZONE`     | Fuseau horaire des dates                                           | `Africa/Tunis`     |
| `NODE_ENV`      | `production` active les cookies sécurisés (HTTPS obligatoire)      | —                  |
| `TRUST_PROXY`   | `1` si le site est derrière un proxy (Nginx, Caddy…)               | —                  |

## Mise en ligne sur votre domaine (OVH)

Le site a besoin d'un petit serveur qui tourne en permanence. L'hébergement fourni avec un nom de domaine ne suffit pas : prenez un **VPS** (le plus petit modèle suffit largement).

### 1. Louer le serveur

Sur [ovhcloud.com](https://www.ovhcloud.com/fr/vps/), commandez un VPS avec le système **Ubuntu 24.04**. OVH vous envoie par e-mail son **adresse IP** (par exemple `51.75.12.34`) et le mot de passe de l'utilisateur `ubuntu`.

### 2. Faire pointer le domaine vers le serveur

Dans l'espace client OVH : **Web Cloud → Noms de domaine → votre domaine → Zone DNS → Ajouter une entrée** :

- type **A**,
- sous-domaine **portail** (le site sera à l'adresse `portail.votre-domaine`),
- cible : l'**adresse IP** du VPS.

La prise en compte prend de quelques minutes à quelques heures.

### 3. Installer le site (depuis un ordinateur)

```bash
scp portail-client.zip ubuntu@ADRESSE_IP:          # envoie le site sur le serveur
ssh ubuntu@ADRESSE_IP                              # se connecte au serveur
sudo apt-get install -y unzip && unzip portail-client.zip
cd client-portal
sudo bash deploy/install.sh portail.votre-domaine.com "Nom du cabinet"
```

Le script affiche ce qu'il va faire et demande confirmation. Il installe Node.js et Caddy (HTTPS automatique), démarre le site comme un service, programme une sauvegarde quotidienne et affiche **le mot de passe provisoire du compte `admin`**.

Ouvrez ensuite `https://portail.votre-domaine.com` et connectez-vous avec `admin`.

### Mettre à jour le site

Recommencez l'étape 3 avec la nouvelle archive : le code est remplacé, les données et les comptes sont conservés.

### Sauvegardes

Une copie de la base est faite chaque nuit dans `/var/backups/portail-client` (14 jours conservés). Pour plus de sécurité, activez aussi l'option de sauvegarde automatique du VPS chez OVH, ou copiez de temps en temps ce dossier sur un autre support.

Pour restaurer une sauvegarde :

```bash
sudo systemctl stop portail-client
sudo cp /var/backups/portail-client/portail-AAAA-MM-JJ….db /var/lib/portail-client/portail.db
sudo rm -f /var/lib/portail-client/portail.db-wal /var/lib/portail-client/portail.db-shm
sudo chown portail:portail /var/lib/portail-client/portail.db
sudo systemctl start portail-client
```

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

- Dépôt de fichiers dans le portail (le client envoie aujourd'hui ses documents par e-mail ou au bureau et le signale d'un clic).
- Notifications par e-mail ou SMS (document demandé, circuit attribué, facture émise).
- Plusieurs utilisateurs côté cabinet, avec leurs propres droits.
- Suivi des délais de magasinage et de restitution des conteneurs.
