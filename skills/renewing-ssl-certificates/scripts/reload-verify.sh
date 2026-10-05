#!/bin/bash
# After Michael's sudo install: force-reload Caddy, clear the staged files, and check what is actually served.
# Usage: reload-verify.sh <domain>
source "$(dirname "$0")/common.sh"
load_domain "${1:-}"

# --force matters: Caddy skips a reload when the Caddyfile is unchanged, so it would keep the old cert.
on_host "$CADDY reload --config $CADDYFILE --force 2>&1 | grep -iE 'error|warn' || true; echo 'caddy reloaded'"
if [ -n "$SSH_TARGET" ]; then
  # mv to Trash, not rm -rf: the dcg guard blocks recursive deletes under ~
  # (find, not a glob: the remote login shell is zsh, which errors on a no-match glob)
  on_host 'find ~ -maxdepth 1 -type d -name "cert-renewal-*" -exec mv {} ~/.Trash/ \; ; echo "staging cleared"'
fi
sleep 2

FAIL=0
for h in $VERIFY_HOSTS; do
  END=$(echo | openssl s_client -connect "$h:443" -servername "$h" 2>/dev/null | openssl x509 -noout -enddate | cut -d= -f2)
  if echo | openssl s_client -connect "$h:443" -servername "$h" 2>/dev/null | openssl x509 -noout -checkend 2592000 >/dev/null; then
    echo "OK    $h  expires $END"
  else
    echo "STALE $h  expires $END (under 30 days left, so the old cert is still being served?)"
    FAIL=1
  fi
done
exit $FAIL
