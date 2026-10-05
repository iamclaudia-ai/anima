---
name: renewing-ssl-certificates
description: "MUST be used when renewing, reissuing, or installing the paid wildcard SSL/TLS certificates for *.kiliman.dev or *.anima-sedes.com (SSL2BUY / Sectigo, served by Caddy on vesuvius and Anima Sedes). Covers generating the key + CSR, the CN-only CSR rule, adding the Sectigo DNS validation CNAME through the Cloudflare API, building the fullchain from the CA's zip, the sudo install, and force-reloading Caddy and checking the served cert. Triggers on: renew cert, renew certificate, reissue certificate, SSL expiring, cert expiring, certificate expires, wildcard cert, CSR, certificate signing request, DCV, domain validation, awaiting validation, SSL2BUY, Sectigo, install cert, update Caddy cert, kiliman.dev cert, anima-sedes cert, HTTPS cert, TLS cert, expiration reminder email."
---

# Renewing SSL Certificates

Michael bought 2-year wildcard orders from SSL2BUY (Sectigo), but each issued cert
only lasts ~6 months, so every order needs a **reissue** twice a year. The CA emails
him about 2 weeks before expiry. First run with this skill: 2026-10-05.

| Domain              | CA order   | Served by                    | Caddy runs as | Cert dir                      |
| ------------------- | ---------- | ---------------------------- | ------------- | ----------------------------- |
| `*.kiliman.dev`     | 2920639138 | Caddy on this Mac (vesuvius) | `michael`     | `/opt/certs/kiliman.dev/`     |
| `*.anima-sedes.com` | 2920590669 | Caddy on Anima Sedes         | `claudia`     | `/opt/certs/anima-sedes.com/` |

Both orders run until **2028-04-19**. Each cert dir holds `fullchain.cer`, `wildcard.key`
and `wildcard.csr`, referenced from `/opt/homebrew/etc/Caddyfile` on that host.
DNS for both zones is **Cloudflare**.

## When to Use

- Michael forwards the "certificate expiring" email or says a cert needs renewing
- The SSL2BUY reissue page asks for a CSR
- An order says "Awaiting Validation" and needs the DNS record
- He downloaded `<order>.zip` and wants it installed

## Available Commands

Invoked through the anima skill runner (`anima skill run renewing-ssl-certificates <cmd> …`),
or directly as `scripts/<cmd>.sh`. Use one workdir per round, e.g. `~/certs/renewal-2027-04`.

- **`make-csr <workdir> <domain>`**: new RSA-2048 key (reused if one is already in the workdir) + CN-only CSR, copied to the clipboard. Prints the DCV hashes to expect.
- **`add-dcv-cname <workdir> <domain> <host> <value>`**: checks the CA's CNAME against the CSR hashes, creates it in Cloudflare (DNS-only, TTL 300), waits until 1.1.1.1 and 8.8.8.8 resolve it.
- **`build-bundle <workdir> <domain> <zip>`**: unzips, builds `fullchain.cer` by walking issuer→subject, verifies key match and chain, prints dates + SAN.
- **`stage <workdir> <domain>`**: scp's the bundle to Sedes when needed, prints the one sudo command for Michael.
- **`reload-verify <domain>`**: `caddy reload --force`, clears staging, checks each host serves a cert with 30+ days left.

`scripts/install-cert.sh` is the root-side installer that Michael runs via sudo (backs up to `backup-<date>/`, installs, key `600` owned by the Caddy user).

## Instructions

Do the two domains one after the other; each step takes seconds.

1. **CSR**: `make-csr ~/certs/renewal-YYYY-MM kiliman.dev`. Tell Michael it's on his
   clipboard; he pastes it on the Reissue page, keeps **DNS** selected, clicks Reissue.
   Repeat for `anima-sedes.com` once he's ready (the clipboard holds one CSR at a time).
2. **DCV**: he clicks "Get DCV Info" and pastes or screenshots the CNAME host + value.
   Run `add-dcv-cname`. If he only sent a screenshot, the hash parts are checked against
   the CSR, but the short mixed-case `<token>` before `.sectigo.com` is read by eye, so ask
   him to paste the value if validation fails. Then he clicks **Retry Validation**.
3. **Bundle**: once validated he downloads `<order>.zip` into the workdir. Run `build-bundle`.
   It must say `key match: yes` and `OK`.
4. **Install**: run `stage`, hand Michael the printed sudo command. Claudia can't run it
   herself: sudo needs a password on both machines.
5. **Reload + verify**: run `reload-verify <domain>`. Every host must say `OK`.

## Gotchas (all hit on the first run)

- **No SAN in the CSR.** SSL2BUY rejects it ("CSR with SAN is not allowed"). Use CN only;
  the CA adds the bare domain to the issued cert's SAN automatically.
- **Sectigo DCV is a CNAME, not a TXT record.** Host = `_<MD5 of CSR DER>.<domain>`, value =
  `<SHA256 first 32>.<SHA256 last 32>.<token>.sectigo.com`. Both hashes are derived from the
  CSR, which is how the script catches typos. Cloudflare stores it lowercase; that's fine.
- **The Cloudflare token** is the one acme.sh saved: `SAVED_CF_Token` in `~/.acme.sh/account.conf`.
  It has DNS edit on both zones. If it ever stops working, the zone lookup fails loudly.
- **SSH to Sedes is `claudia@anima-sedes.tail2981c.ts.net`.** There is no `michael`
  account on Sedes (admin group = root, claudia), so `ssh anima-sedes` as michael always
  rejects the password. Key auth works without a password; `sudo` asks for the **claudia** password.
- **`caddy reload` needs `--force`.** With an unchanged Caddyfile it's a no-op and keeps
  serving the old cert from memory.
- **Fullchain order** = leaf, SSL2BUY EMEA RSA DV intermediate, Sectigo R46 cross-cert,
  USERTrust RSA root (4 certs), matching what was installed before.
- **Don't `rm -rf` under `~`** (the dcg guard blocks it); staging goes to `~/.Trash`.
- The remote login shell on Sedes is zsh: an unmatched glob is an error, so use `find`.
- **Keys never leave the machines.** Only the CSR goes to the CA. The workdir keys stay `600`.
- Old DCV CNAMEs in Cloudflare are harmless leftovers (they're tied to the old CSR); delete them if tidying.

## Future

Michael wants to move to **Caddy + Cloudflare DNS + Let's Encrypt** (automatic renewal via
the `caddy-dns/cloudflare` module) once these orders expire in April 2028. His earlier
attempt was buggy. When that happens, this skill becomes obsolete.
