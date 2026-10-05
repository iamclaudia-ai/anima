#!/bin/bash
# Generate (or reuse) an RSA-2048 key and a CN-only CSR for *.<domain>; copy the CSR to the clipboard.
# Usage: make-csr.sh <workdir> <domain>
source "$(dirname "$0")/common.sh"
WORK=${1:?workdir}
load_domain "${2:-}"
mkdir -p "$WORK"
cd "$WORK"

if [ -f "$KEY_NAME" ]; then
  echo "reusing existing key $WORK/$KEY_NAME"
else
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY_NAME" 2>/dev/null
fi
chmod 600 "$KEY_NAME"

# CN only: SSL2BUY rejects a CSR carrying a SAN, and adds the bare domain itself.
openssl req -new -key "$KEY_NAME" -sha256 -subj "/CN=*.$DOMAIN" -out "$CSR_NAME"
openssl req -in "$CSR_NAME" -noout -verify 2>&1
pbcopy < "$CSR_NAME"
echo "CSR for *.$DOMAIN copied to clipboard (CA order $ORDER)"

read -r M S <<< "$(dcv_hashes "$CSR_NAME")"
echo "expected DCV CNAME host:  _$M.$DOMAIN"
echo "expected DCV CNAME value: $S.<token>.sectigo.com"
