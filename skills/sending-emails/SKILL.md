---
name: sending-emails
description: "MUST be used when you need to send a real email, or test how an HTML email renders in real inboxes (Gmail, Apple Mail). Sends through Resend with the `resend` CLI (key already in the env, verified sender domains ready), and covers the real-inbox test loop: render a Rails mailer to HTML, send every variant in ONE email, inspect Gmail yourself, get an Apple Mail screenshot from Michael. Triggers on: send email, send an email, email me, test email, send a test, real inbox, live email test, check in Gmail, check in Apple Mail, email rendering, how does this email look, email client, auto-linking, blue links, mailer preview, resend, sendtrap, mailtrap, deliver to my inbox."
---

# Sending Emails

Send real email through **Resend** with the `resend` CLI. Use it to get mail into a real inbox,
most often to see how an HTML email _actually_ renders in a mail client. Local and staging app
mail never gets that far.

## When to Use

- Testing how an HTML email renders in a real client (Gmail, Apple Mail): auto-linking, dark
  mode, layout, fonts, clipping
- Sending Michael something by email because he asked for it
- Any time the "email" a project sends is caught by a local catcher and you need the real thing

**Why not just send it from the app?** beehiiv's Swarm delivers to **sendtrap** locally and on
staging (see swarm memory `reference_sendtrap_local_sendgrid_mock`), so nothing reaches a real
inbox. Other projects have their own local catchers (mailtrap, letter_opener). Resend is the way
out.

## Setup (already done)

- `RESEND_API_KEY` is in the environment, and `resend` is installed (`/opt/homebrew/bin/resend`).
  Check with `resend domains list`.
- **Verified sender domains:** `mail.3votech.com`, `mail.tossit.sh`, `mail.nutwords.com`,
  `the-nuthouse.com`, `fuse.do`. The default for tests is
  `Claudia <claudia@mail.3votech.com>`.

## Test inboxes (Michael approved these)

| Client         | Address               |
| -------------- | --------------------- |
| **Gmail**      | `kiliman@gmail.com`   |
| **Apple Mail** | `michael@3votech.com` |

Never send anywhere else without asking. Resend sends from real domains, and a stray send
reaches a real person.

## Sending

```bash
resend -q emails send \
  --from "Claudia <claudia@mail.3votech.com>" \
  --to kiliman@gmail.com michael@3votech.com \
  --subject "[TICKET test] AFTER: what this shows" \
  --html-file /absolute/path/body.html
# → { "id": "01a0…" }

resend -q emails get <id>     # "last_event": "delivered" once it has landed
resend emails share <id>      # shareable link to the sent email (Resend's render, NOT a client's)
```

- `-q` gives plain JSON with no spinners. `--text` / `--text-file` for plain text.
  `--dry-run` validates without sending.
- **Put a ticket tag in the subject** (`[BEE-25920 test] …`) so the tests are easy to find and
  delete, and name the variant (BEFORE / AFTER / VARIANTS).
- Write HTML bodies with the **Write tool**, not a heredoc. Markdown or HTML lines starting with a
  backtick trip dcg's `heredoc.shell:launcher-unverified` rule.

## Testing email rendering in real clients

### 1. Get the real HTML

Render the app's own mailer rather than a hand-copied approximation. For a Rails mailer, write a
`rails runner` script that builds the message and dumps it:

```ruby
mail = App::SomeMailer.some_action(**args)
mail.to = "qa@example.com"            # the address is irrelevant, it never sends
File.write(ARGV.fetch(0), mail.message.to_s)
```

Then pull the HTML part out of the `.eml` (it's quoted-printable, so `grep` on the raw file lies):

```python
import email
msg = email.message_from_bytes(open("after.eml", "rb").read())
html = next(p.get_payload(decode=True).decode(p.get_content_charset() or "utf-8")
            for p in msg.walk() if p.get_content_type() == "text/html")
open("after.html", "w").write(html)
```

For a **before/after**, render once with `main`'s template file-copied in, then restore it
(`cp` to the scratchpad, never `git stash`).

### 2. Send every candidate in ONE email

When you're choosing between techniques, don't send them one at a time. Build **one** email with
a labelled row per variant, **plus a plain control row** (which proves the client does the thing
at all). One screenshot then answers everything. Michael called this smart; it turned a
guess-and-resend loop into a single round.

### 3. Check Gmail yourself

Use `controlling-the-browser`. **Tell Michael before you open tabs in his Chrome.** Otherwise he
sees tabs popping open on their own and closes them.

```bash
anima dominatrix navigate --tabId new --profile kiliman@gmail.com \
  --url "https://mail.google.com/mail/u/0/#search/in%3Aanywhere+subject%3A%22TICKET+test%22"
# find_text misses Gmail's split subjects, so click the row directly
anima dominatrix eval --expression "var rows = Array.from(document.querySelectorAll('tr.zA')).filter(r => r.textContent.indexOf('VARIANTS') >= 0); if (rows.length) { rows[0].click(); } rows.length"
# the message body is div.a3s: read the hrefs Gmail actually rendered, plus computed styles
anima dominatrix eval --expression "Array.from(document.querySelectorAll('div.a3s a')).map(a => a.getAttribute('href') + ' | ' + a.textContent.trim() + ' | ' + window.getComputedStyle(a).cursor).join('\n')"
anima dominatrix close_tab
```

- **A new sender lands in Spam.** Search `in:anywhere`, and click "Report not spam" on your own
  test thread before judging it, because Gmail treats links differently in Spam.
- Reading the DOM is more precise than a screenshot: it shows what Gmail rewrote (`href="#"`
  became `#m_…`, an empty href was stripped, inline `cursor` was dropped).

### 4. Apple Mail: ask Michael

This shell has **no screen-recording permission**, so `screencapture -l <window>` fails on Mail
windows. Don't work around it. Ask Michael for a screenshot, and name exactly what to check
(plain vs linked, cursor, double-click vs drag to select, what a click does).

## Hard-won client facts

- **Stopping auto-linking of domain-shaped text** (DNS values, hostnames): wrap it in
  `<a href="" style="color:…;text-decoration:none;cursor:text">`. It is the only technique that
  reads as plain, selectable text in **both** clients. Apple Mail's data detectors read the text,
  not the markup, so they link through hrefless anchors and any `<span>`/`<wbr>` split. Gmail
  strips an empty href, but rewrites `#` into a draggable in-page link. Full matrix: swarm memory
  `reference_email_autolink_apple_mail_and_live_testing`, and beehiiv/swarm PR #30395.
- **Never use invisible characters** (zero-width space, word joiner, soft hyphen) in anything
  meant to be copied. They ride along into the paste.
- **Web-search advice about email clients goes stale fast.** The textbook fix (a hrefless anchor)
  failed in Apple Mail. Test instead of trusting it.
- **Gmail strips `cursor`** (and other properties) from inline styles.

## Notes

- Sending real mail is an external action. The test inboxes above are pre-approved; anything
  else (other people, lists, batch sends) needs Michael's OK first.
- Clean up afterwards: tell Michael the test threads can be deleted, and close any tabs you opened.
