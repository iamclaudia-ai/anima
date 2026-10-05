#!/bin/bash
# Root-side install, run by MICHAEL with sudo (needs a password, so Claudia can't run it).
# Backs up the current files, installs the new ones, locks the key to the Caddy user.
# Usage: sudo install-cert.sh <src-dir> <cert-dir> <owner>
set -euo pipefail
SRC=${1:?src dir}
DST=${2:?cert dir}
OWNER=${3:?owner}
BAK=$DST/backup-$(date +%Y-%m-%d)

mkdir -p "$BAK"
cp -p "$DST"/fullchain.cer "$DST"/wildcard.key "$DST"/wildcard.csr "$BAK"/
chmod 600 "$BAK/wildcard.key"
install -m 644 -o root -g wheel "$SRC/fullchain.cer" "$DST/fullchain.cer"
install -m 644 -o root -g wheel "$SRC/wildcard.csr" "$DST/wildcard.csr"
# Caddy runs as $OWNER (brew services), so the key is theirs and nobody else's.
install -m 600 -o "$OWNER" -g staff "$SRC/wildcard.key" "$DST/wildcard.key"
ls -la "$DST" "$BAK"
