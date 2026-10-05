#!/bin/bash
# Put the verified bundle where the install step can reach it, and print the one sudo command for Michael.
# Usage: stage.sh <workdir> <domain>
source "$(dirname "$0")/common.sh"
WORK=${1:?workdir}
load_domain "${2:-}"
OUT=$WORK/$DOMAIN
INSTALLER=$(cd "$(dirname "$0")" && pwd)/install-cert.sh
for f in fullchain.cer wildcard.key wildcard.csr; do
  [ -f "$OUT/$f" ] || { echo "missing $OUT/$f; run build-bundle first" >&2; exit 1; }
done

if [ -z "$SSH_TARGET" ]; then
  echo "local host, nothing to copy. Michael runs:"
  echo
  echo "  sudo $INSTALLER $OUT $CERT_DIR $OWNER"
else
  STAGE=cert-renewal-$(date +%Y-%m)
  ssh -o BatchMode=yes "$SSH_TARGET" "mkdir -p -m 700 ~/$STAGE"
  scp -q -o BatchMode=yes "$OUT/fullchain.cer" "$OUT/wildcard.key" "$OUT/wildcard.csr" "$INSTALLER" "$SSH_TARGET:$STAGE/"
  ssh -o BatchMode=yes "$SSH_TARGET" "chmod 600 ~/$STAGE/wildcard.key; ls -la ~/$STAGE"
  echo
  echo "staged on $SSH_TARGET:~/$STAGE. Michael runs (sudo asks for the $OWNER account password):"
  echo
  echo "  ssh -t $SSH_TARGET 'sudo ~/$STAGE/install-cert.sh ~/$STAGE $CERT_DIR $OWNER'"
fi
