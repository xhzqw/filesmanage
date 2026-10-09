#!/usr/bin/env bash
# Provision a small root-owned LAN CA and two HTTPS-only nginx development
# front doors. This NEVER modifies nginx's existing 80/443 sites or 8091.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
REPO="$(pwd -P)"
TLS_DIR="$REPO/.secrets/lan-tls"
SITE="/etc/nginx/sites-available/filesmanage-lan-https"
ENABLED="/etc/nginx/sites-enabled/filesmanage-lan-https"
SRC="$REPO/deploy/nginx/filesmanage-lan-https.conf"
if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root on the target machine" >&2; exit 1
fi
if [[ ! -r "$SRC" ]]; then
  echo "missing source nginx config: $SRC" >&2; exit 1
fi
mkdir -p "$TLS_DIR"
chmod 700 "$TLS_DIR"

if [[ ! -e "$TLS_DIR/ca.crt" && ! -e "$TLS_DIR/ca.key" ]]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -noenc \
    -sha256 -days 3650 -keyout "$TLS_DIR/ca.key" -out "$TLS_DIR/ca.crt" \
    -subj "/O=Filesmanage LAN/CN=Filesmanage Internal Root CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
fi
if [[ ! -f "$TLS_DIR/ca.key" || ! -f "$TLS_DIR/ca.crt" ]]; then
  echo "incomplete CA: refusing to overwrite an existing root" >&2; exit 1
fi
if ! openssl x509 -in "$TLS_DIR/ca.crt" -noout -checkend 2592000 >/dev/null; then
  echo "root CA nearing expiry: rotate it deliberately, not silently" >&2; exit 1
fi
chmod 600 "$TLS_DIR/ca.key"

renew=false
if [[ ! -f "$TLS_DIR/server.crt" || ! -f "$TLS_DIR/server.key" ]]; then
  renew=true
elif ! openssl x509 -in "$TLS_DIR/server.crt" -noout -checkend 2592000 >/dev/null; then
  renew=true
elif ! openssl x509 -in "$TLS_DIR/server.crt" -noout -checkip 192.168.1.22 >/dev/null; then
  renew=true
elif ! openssl x509 -in "$TLS_DIR/server.crt" -noout -checkip 10.144.144.1 >/dev/null; then
  renew=true
fi

if [[ "$renew" == true ]]; then
  ext="$(mktemp "$TLS_DIR/leaf.XXXXXXXX.ext")"
  csr="$(mktemp "$TLS_DIR/leaf.XXXXXXXX.csr")"
  trap 'rm -f "$ext" "$csr"' EXIT
  cat > "$ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:192.168.1.22,IP:10.144.144.1,DNS:openclaw77
EOF
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -noenc \
    -keyout "$TLS_DIR/server.key.new" -out "$csr" \
    -subj "/O=Filesmanage LAN/CN=openclaw77"
  openssl x509 -req -in "$csr" -CA "$TLS_DIR/ca.crt" \
    -CAkey "$TLS_DIR/ca.key" -CAcreateserial -days 397 -sha256 \
    -extfile "$ext" -out "$TLS_DIR/server.crt.new"
  openssl verify -CAfile "$TLS_DIR/ca.crt" "$TLS_DIR/server.crt.new"
  mv -f "$TLS_DIR/server.key.new" "$TLS_DIR/server.key"
  mv -f "$TLS_DIR/server.crt.new" "$TLS_DIR/server.crt"
fi
chmod 600 "$TLS_DIR/server.key"
chmod 644 "$TLS_DIR/ca.crt" "$TLS_DIR/server.crt"

if [[ -e "$ENABLED" && ! -L "$ENABLED" ]]; then
  echo "refusing to replace an unexpected enabled-site file: $ENABLED" >&2; exit 1
fi
if [[ -L "$ENABLED" && "$(readlink -f "$ENABLED")" != "$SITE" ]]; then
  echo "refusing to replace an unexpected nginx site link" >&2; exit 1
fi
install -m 644 "$SRC" "$SITE"
ln -sfn "$SITE" "$ENABLED"
nginx -t
systemctl reload nginx
echo "LAN HTTPS ready (ports 18443 and 18444; old 18091 unchanged)."
echo "CA public certificate: $TLS_DIR/ca.crt"
openssl x509 -in "$TLS_DIR/ca.crt" -noout -fingerprint -sha256
openssl x509 -in "$TLS_DIR/server.crt" -noout -dates -ext subjectAltName
