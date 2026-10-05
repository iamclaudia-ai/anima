#!/bin/bash
# Unzip the CA's cert zip, build fullchain.cer (leaf, then each issuer in turn), verify it against our key.
# Usage: build-bundle.sh <workdir> <domain> <zip>
source "$(dirname "$0")/common.sh"
WORK=${1:?workdir}
load_domain "${2:-}"
ZIP=${3:?zip}
OUT=$WORK/$DOMAIN
rm -f "$OUT"/zip/*.crt 2>/dev/null || true
mkdir -p "$OUT/zip"
unzip -o -q "$ZIP" -d "$OUT/zip"

LEAF=$(ls "$OUT"/zip/STAR_*.crt | head -1)
# Walk issuer -> subject so chain order never depends on file names.
# Order matches what was installed before: leaf, SSL2BUY intermediate, R46 cross-cert, USERTrust root.
cp "$LEAF" "$OUT/fullchain.cer"
: > "$OUT/chain.pem"
CUR=$LEAF
for _ in 1 2 3 4 5; do
  ISS=$(issuer_of "$CUR")
  [ "$ISS" = "$(subject_of "$CUR")" ] && break   # self-signed root reached
  NEXT=""
  for c in "$OUT"/zip/*.crt; do
    [ "$(subject_of "$c")" = "$ISS" ] && NEXT=$c
  done
  [ -z "$NEXT" ] && break
  cat "$NEXT" >> "$OUT/fullchain.cer"
  cat "$NEXT" >> "$OUT/chain.pem"
  CUR=$NEXT
done

cp "$WORK/$KEY_NAME" "$OUT/wildcard.key"
cp "$WORK/$CSR_NAME" "$OUT/wildcard.csr"
chmod 600 "$OUT/wildcard.key"

echo "certs in fullchain: $(grep -c 'BEGIN CERT' "$OUT/fullchain.cer")"
openssl crl2pkcs7 -nocrl -certfile "$OUT/fullchain.cer" | openssl pkcs7 -print_certs -noout | grep subject
K1=$(openssl x509 -in "$LEAF" -noout -pubkey | openssl sha256 -r)
K2=$(openssl pkey -in "$OUT/wildcard.key" -pubout | openssl sha256 -r)
if [ "$K1" != "$K2" ]; then
  echo "key match: NO, this cert was issued for a different CSR/key" >&2
  exit 1
fi
echo "key match: yes"
openssl verify -untrusted "$OUT/chain.pem" "$LEAF"
openssl x509 -in "$LEAF" -noout -subject -dates -ext subjectAltName
echo "bundle ready: $OUT"
