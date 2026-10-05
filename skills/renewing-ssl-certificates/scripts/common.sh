#!/bin/bash
# Shared config + helpers for the wildcard-cert renewal scripts.
set -euo pipefail

# Per-domain facts. Add a domain here and every script picks it up.
load_domain() {
  case "${1:-}" in
    kiliman.dev)
      ORDER=2920639138
      SSH_TARGET=""                       # Caddy on this Mac (vesuvius)
      OWNER=michael                       # user Caddy runs as (brew services)
      VERIFY_HOSTS="anima.kiliman.dev watchdog.kiliman.dev"
      ;;
    anima-sedes.com)
      ORDER=2920590669
      SSH_TARGET=claudia@anima-sedes.tail2981c.ts.net   # there is NO michael account on Sedes
      OWNER=claudia
      VERIFY_HOSTS="gateway.anima-sedes.com watchdog.anima-sedes.com bluebubbles.anima-sedes.com"
      ;;
    *) echo "unknown domain '${1:-}' (known: kiliman.dev, anima-sedes.com)" >&2; exit 1 ;;
  esac
  DOMAIN=$1
  CERT_DIR=/opt/certs/$DOMAIN             # fullchain.cer, wildcard.key, wildcard.csr
  CADDYFILE=/opt/homebrew/etc/Caddyfile
  CADDY=/opt/homebrew/bin/caddy
  KEY_NAME=STAR_$DOMAIN.key
  CSR_NAME=STAR_$DOMAIN.csr
}

# Run a shell snippet on the domain's host (local when SSH_TARGET is empty).
on_host() {
  if [ -z "$SSH_TARGET" ]; then bash -c "$1"; else ssh -o BatchMode=yes "$SSH_TARGET" "$1"; fi
}

# Cloudflare API token acme.sh already saved (has DNS edit on both zones).
cf_token() { grep -h '^SAVED_CF_Token' ~/.acme.sh/account.conf | head -1 | cut -d"'" -f2; }

# Sectigo DCV hashes for a CSR: "<MD5> <SHA256-first-32>.<SHA256-last-32>", uppercase.
dcv_hashes() {
  local der m s
  der=$(mktemp)
  openssl req -in "$1" -outform DER -out "$der"
  m=$(openssl dgst -md5 -r "$der" | cut -c1-32 | tr a-f A-F)
  s=$(openssl dgst -sha256 -r "$der" | cut -c1-64 | tr a-f A-F)
  rm -f "$der"
  echo "$m ${s:0:32}.${s:32:32}"
}

subject_of() { openssl x509 -in "$1" -noout -subject -nameopt RFC2253 | sed 's/^subject=//'; }
issuer_of() { openssl x509 -in "$1" -noout -issuer -nameopt RFC2253 | sed 's/^issuer=//'; }
