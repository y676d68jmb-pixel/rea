#!/usr/bin/env bash
# Installe ou met à jour le portail client sur un serveur Ubuntu/Debian (par exemple un VPS OVH).
# Usage : sudo bash deploy/install.sh portail.mon-domaine.com ["Nom du cabinet"]
# Relancer le script avec une nouvelle version du site la met à jour sans toucher aux données.
set -euo pipefail

DOMAIN="${1:-}"
SITE_NAME="${2:-Espace client}"
APP_DIR=/opt/portail-client
DATA_DIR=/var/lib/portail-client
BACKUP_DIR=/var/backups/portail-client
ENV_FILE=/etc/portail-client.env
CADDYFILE=/etc/caddy/Caddyfile
APP_USER=portail
PORT=3000
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() {
  echo "Erreur : $*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || die "lancez ce script avec sudo."
[[ $DOMAIN =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] ||
  die 'usage : sudo bash deploy/install.sh portail.mon-domaine.com ["Nom du cabinet"]'
[[ $SITE_NAME =~ ^[^\"\\$\`]{1,100}$ ]] || die 'le nom du cabinet ne doit pas contenir de guillemets, $, ` ou \.'
command -v apt-get >/dev/null || die "ce script fonctionne sur Ubuntu ou Debian."
command -v systemctl >/dev/null || die "systemd est nécessaire."
[[ -f $SRC_DIR/src/server.js ]] || die "lancez le script depuis le dossier client-portal décompressé."
[[ $SRC_DIR != "$APP_DIR" ]] || die "lancez le script depuis le dossier décompressé, pas depuis $APP_DIR."

# ---------- Plan ----------

SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR == 1 {print $1}' || true)"

cat <<EOF

Installation du portail client pour https://$DOMAIN

Ce script va :
  1. installer Node.js 22 (si absent ou trop ancien) et Caddy (serveur web HTTPS) ;
  2. copier le site dans $APP_DIR (données dans $DATA_DIR, jamais effacées) ;
  3. créer le service « portail-client », démarré automatiquement avec le serveur ;
  4. remplacer $CADDYFILE pour servir https://$DOMAIN
     (l'ancien fichier est sauvegardé à côté s'il est différent) ;
  5. programmer une sauvegarde quotidienne de la base (14 jours) dans $BACKUP_DIR,
     et, lors d'une mise à jour, sauvegarder la base avant de redémarrer le site ;
  6. lors de la première installation, créer le compte administrateur « admin ».

EOF

if [[ -z $DNS_IP ]]; then
  echo "Attention : $DOMAIN ne pointe encore vers aucune adresse."
  echo "Ajoutez l'entrée DNS (type A → ${SERVER_IP:-adresse IP de ce serveur}) chez OVH, sinon le certificat HTTPS ne pourra pas être obtenu."
  echo
elif [[ -n $SERVER_IP && $DNS_IP != "$SERVER_IP" ]]; then
  echo "Attention : $DOMAIN pointe vers $DNS_IP, mais ce serveur a l'adresse $SERVER_IP."
  echo "Si ce n'est pas voulu, corrigez l'entrée DNS chez OVH : le certificat HTTPS ne pourra pas être obtenu."
  echo
fi

read -r -p "Continuer ? [o/N] " answer
[[ $answer =~ ^[oOyY]$ ]] || die "installation annulée, rien n'a été modifié."

# ---------- Node.js ----------

node_ok() {
  command -v node >/dev/null &&
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'
}

export DEBIAN_FRONTEND=noninteractive
if ! node_ok; then
  echo "→ Installation de Node.js 22"
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node_ok || die "Node.js 22.13 ou plus récent n'a pas pu être installé."
NODE_BIN="$(command -v node)"

# ---------- Caddy ----------

if ! command -v caddy >/dev/null; then
  echo "→ Installation de Caddy"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
    gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

# ---------- Application ----------

echo "→ Copie du site"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$DATA_DIR" "$BACKUP_DIR"

rm -rf "$APP_DIR.new"
install -d -m 755 "$APP_DIR.new"
cp -R "$SRC_DIR/package.json" "$SRC_DIR/src" "$SRC_DIR/public" "$SRC_DIR/scripts" "$APP_DIR.new/"
chown -R root:root "$APP_DIR.new"
chmod -R u=rwX,go=rX "$APP_DIR.new"
rm -rf "$APP_DIR.old"
[[ -d $APP_DIR ]] && mv "$APP_DIR" "$APP_DIR.old"
mv "$APP_DIR.new" "$APP_DIR"

if [[ ! -f $ENV_FILE ]]; then
  cat >"$ENV_FILE" <<EOF
NODE_ENV=production
TRUST_PROXY=1
HOST=127.0.0.1
PORT=$PORT
DATABASE_FILE=$DATA_DIR/portail.db
SITE_NAME="$SITE_NAME"
CURRENCY=TND
TIME_ZONE=Africa/Tunis
# Phrase affichée au client sous la liste des documents à fournir :
DOCUMENTS_HINT="Transmettez vos documents au cabinet par e-mail ou déposez-les au bureau, en indiquant la référence du dossier."
EOF
  chmod 644 "$ENV_FILE"
fi

ADMIN_OUTPUT=""
if [[ ! -f $DATA_DIR/portail.db ]]; then
  echo "→ Création du compte administrateur"
  ADMIN_OUTPUT="$(cd / && runuser -u "$APP_USER" -- env DATABASE_FILE="$DATA_DIR/portail.db" \
    "$NODE_BIN" --disable-warning=ExperimentalWarning "$APP_DIR/scripts/create-admin.js" admin "$SITE_NAME")"
fi

# ---------- Services ----------

echo "→ Configuration des services"
HARDENING="NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true"

cat >/etc/systemd/system/portail-client.service <<EOF
[Unit]
Description=Portail client
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning $APP_DIR/src/server.js
Restart=on-failure
RestartSec=3
ReadWritePaths=$DATA_DIR
$HARDENING

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/portail-client-backup.service <<EOF
[Unit]
Description=Sauvegarde du portail client

[Service]
Type=oneshot
User=$APP_USER
Group=$APP_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning $APP_DIR/scripts/backup.js $BACKUP_DIR 14
ReadWritePaths=$DATA_DIR $BACKUP_DIR
$HARDENING
EOF

cat >/etc/systemd/system/portail-client-backup.timer <<EOF
[Unit]
Description=Sauvegarde quotidienne du portail client

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --quiet portail-client portail-client-backup.timer
if [[ -f $DATA_DIR/portail.db ]] && systemctl is-active --quiet portail-client; then
  echo "→ Sauvegarde de la base avant la mise à jour"
  (cd / && runuser -u "$APP_USER" -- env DATABASE_FILE="$DATA_DIR/portail.db" \
    "$NODE_BIN" --disable-warning=ExperimentalWarning "$APP_DIR/scripts/backup.js" "$BACKUP_DIR" 14)
fi
systemctl restart portail-client
systemctl start portail-client-backup.timer

for _ in $(seq 1 20); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/connexion" && break
  sleep 0.5
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/connexion" ||
  die "le site ne démarre pas. Détails : journalctl -u portail-client -n 50 (l'ancienne version est dans $APP_DIR.old)."

# ---------- HTTPS ----------

DESIRED_CADDYFILE="$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT
}
"
install -d -m 755 "$(dirname "$CADDYFILE")"
if [[ -f $CADDYFILE ]] && [[ "$(cat "$CADDYFILE")"$'\n' != "$DESIRED_CADDYFILE" ]]; then
  cp -p "$CADDYFILE" "$CADDYFILE.bak-$(date +%Y%m%d-%H%M%S)"
fi
printf '%s' "$DESIRED_CADDYFILE" >"$CADDYFILE"
caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 || die "configuration Caddy invalide ($CADDYFILE)."
systemctl enable --quiet caddy
systemctl reload-or-restart caddy

if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

# ---------- Résumé ----------

cat <<EOF

✔ Portail client installé : https://$DOMAIN
  (le certificat HTTPS est obtenu automatiquement, cela peut prendre une minute)

EOF
if [[ -n $ADMIN_OUTPUT ]]; then
  echo "$ADMIN_OUTPUT"
  echo
  echo "Connectez-vous avec l'identifiant « admin » et ce mot de passe provisoire, puis choisissez le vôtre."
else
  echo "Mise à jour terminée : vos données et vos comptes sont conservés."
fi
cat <<EOF

Commandes utiles :
  journalctl -u portail-client -f                      voir le journal du site
  sudo systemctl start portail-client-backup            sauvegarder maintenant
  ls $BACKUP_DIR                    lister les sauvegardes
EOF
