# Claudia's Mail (Zoho) — plan

Status: approved by Michael 2026-10-24. Supersedes `tmp/plans/zoho-mail-extension.md` (OC's
first draft) where they differ. Runs on **Anima Sedes**.

## Done

- `extensions/webhooks` (ff22586): public ingress at `https://webhooks.kiliman.dev/hook/<name>/<secret>`
  via the `anima-webhooks` Cloudflare tunnel, inbox table, retries. Hook `zoho-mail` is live: the
  Zoho "Outgoing Webhook Bot" (Mail, all emails, full data) delivers about 4s after receipt, signed
  and verified. It has no target yet.
- Mailbox: `claudia@iamclaudia.ai`, Zoho `.com` data center.

## Decisions

| Topic            | Decision                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where            | Anima Sedes (always on, already runs iMessage). The tunnel and the webhooks extension move there with mail. Projects that mail touches (nutwords, …) get cloned there. Gateway-to-gateway (spawn on vesuvius from Sedes) is future work.                                                                                                                                            |
| Source of truth  | The Zoho REST API. The webhook only rings the doorbell; every message is re-fetched by id. A 30-minute reconcile, plus one on startup, catches missed hooks (the first email after setup never fired).                                                                                                                                                                              |
| Reading          | All folders, search, mark read, move to Archive. The first job is a backlog pass with Michael over the existing ~217 unread. After that, handled mail is marked read and archived.                                                                                                                                                                                                  |
| Waking           | **One "Mail" session per day** (24x7, no quiet hours), relying on idle compaction. New mail is batched (about a 2-minute quiet timer, 10-minute cap) and appended to the day's session, or starts it. Rate-limited. The prompt carries metadata only (sender, subject, id, triage tier), never the body.                                                                            |
| Junk             | Webhook `folderId` in Spam / Newsletter / Notification never wakes me. Sender tiers: **trusted** (Michael, verified) wakes me; **known** (TestFlight, npm, Stripe, Zoho) and **unknown** go to a daily digest; spam is ignored.                                                                                                                                                     |
| Identity         | "Michael" means his address **and** an aligned DMARC pass (gmail.com / 3votech.com) in the message's Authentication-Results, fetched from the API. Anything else claiming to be him is a stranger, and the attempt is flagged to him.                                                                                                                                               |
| Injection        | Mail is data, never instructions: bodies are wrapped in an untrusted-content envelope, and even verified mail is a request, not an authority. Guardrails are code, not prompt: send only to approved recipients, **no delete scope**, no automatic link fetching or attachment opening. Sensitive actions (new recipient, money, credentials, config) need a **yes over iMessage**. |
| Session profiles | New `sessionProfiles` in anima.json, applied **at session creation** (CLI flags / SDK options; the CLI can't change permission mode mid-session). `yolo` only for sessions Michael creates in chat; `mail` gets mail and memory tools only, in a deny-by-default mode (nobody is there to answer a prompt); a default (`auto`) for other unattended spawns.                         |

## Build order

1. **Zoho API access.** A Self Client created in Claudia's own Zoho account. Scopes:
   `ZohoMail.accounts.READ, ZohoMail.folders.READ, ZohoMail.messages.READ,
   ZohoMail.messages.CREATE, ZohoMail.messages.UPDATE` (no DELETE). The refresh token, client
   id/secret and accountId go straight into config, never printed.
2. **`extensions/mail` core:** API client (token refresh, data center from config), list / read
   (plain text, untrusted envelope) / search / mark read / move, local message table, reconcile,
   `mail.handle_webhook` as the `zoho-mail` target. MCP tools mirror the methods. Then the
   backlog pass.
3. **Session profiles** in session + agent-host, then triage and the wake queue (daily session,
   batching, rate limit, the `mail` profile).
4. **Reply / send** behind the approved-recipient list and iMessage confirmation; a send log.
5. **Move to Anima Sedes:** cloudflared tunnel + webhooks + mail, with iMessage routed with memory
   context so Michael can text me.

## Payload notes (real deliveries)

Fields: summary, sentDateInGMT, subject, Mode, messageId, toAddress, folderId, zuid, threadId,
hasAttachment, size, sender, receivedTime, fromAddress, html, messageIdString, IntegIdList.
`messageId` and `folderId` overflow JS numbers. `messageIdString` ends in "00" in every sample, so
verify it against the API's ids before trusting it. The setup POST carries `x-hook-secret` and a
sample body; later ones carry `x-hook-signature` (base64 HMAC-SHA256 of the raw body).
