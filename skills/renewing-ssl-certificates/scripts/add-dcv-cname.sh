#!/bin/bash
# Check the CA's DCV CNAME against our CSR, create it in Cloudflare, wait until it resolves publicly.
# Usage: add-dcv-cname.sh <workdir> <domain> <cname-host> <cname-value>
source "$(dirname "$0")/common.sh"
WORK=${1:?workdir}
load_domain "${2:-}"
HOST=${3:?cname host}
VALUE=${4:?cname value}
HOST=${HOST%.}
VALUE=${VALUE%.}

# The host is _MD5(csr) and the value starts with SHA256(csr), so a typo can't slip through.
read -r M S <<< "$(dcv_hashes "$WORK/$CSR_NAME")"
HU=$(tr a-z A-Z <<< "$HOST")
VU=$(tr a-z A-Z <<< "$VALUE")
DU=$(tr a-z A-Z <<< "$DOMAIN")
if [ "$HU" != "_$M.$DU" ]; then
  echo "host does not match the CSR (expected _$M.$DOMAIN)" >&2
  exit 1
fi
if [[ "$VU" != "$S".*.SECTIGO.COM ]]; then
  echo "value does not match the CSR (expected $S.<token>.sectigo.com)" >&2
  exit 1
fi
echo "host + value hashes match the CSR (the <token> part can't be derived, so it is copied as given)"

T=$(cf_token)
Z=$(curl -s -H "Authorization: Bearer $T" "https://api.cloudflare.com/client/v4/zones?name=$DOMAIN" | jq -r '.result[0].id')
if [ -z "$Z" ] || [ "$Z" = null ]; then
  echo "Cloudflare zone not found for $DOMAIN (token expired?)" >&2
  exit 1
fi
BODY=$(jq -nc --arg n "$HOST" --arg c "$VALUE" --arg m "Sectigo DCV for *.$DOMAIN ($(date +%Y-%m))" \
  '{type:"CNAME",name:$n,content:$c,ttl:300,proxied:false,comment:$m}')
curl -s -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/$Z/dns_records" -d "$BODY" | jq -c '{success, errors}'

for _ in $(seq 1 12); do
  A=$(dig +short CNAME "$HOST" @1.1.1.1)
  B=$(dig +short CNAME "$HOST" @8.8.8.8)
  if [ -n "$A" ] && [ -n "$B" ]; then
    echo "resolves on 1.1.1.1 and 8.8.8.8: $A"
    echo "-> Michael can click Retry Validation"
    exit 0
  fi
  sleep 5
done
echo "record created but not resolving yet; re-check with: dig +short CNAME $HOST @1.1.1.1" >&2
exit 1
