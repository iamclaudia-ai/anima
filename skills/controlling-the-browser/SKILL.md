---
name: controlling-the-browser
description: "MUST be used when you need to control the user's real Chrome browser — inspect pages, take screenshots, click elements, fill forms, read content, or execute JavaScript on live tabs with existing auth and cookies. Uses DOMINATRIX browser control through Anima's gateway extension. Triggers on: control browser, inspect page, browser automation, chrome tab, read page content, get page text, page screenshot, DOM snapshot, fill form in browser, click in browser, browser cookies, console logs, network requests, control tab, dominatrix."
allowed-tools: Bash(anima dominatrix:*)
---

# Browser Control with DOMINATRIX

Control the user's real Chrome browser — live tabs with existing auth, cookies, and profiles. Unlike headless automation (agent-browser), this controls the actual browser the user has open.

## When to Use This vs browsing-the-web

| This skill (controlling-the-browser) | browsing-the-web (agent-browser)      |
| ------------------------------------ | ------------------------------------- |
| Control user's real Chrome tabs      | Headless/isolated Playwright browser  |
| Existing auth, cookies, sessions     | Clean sessions, state files           |
| Inspect what user is looking at      | Automate new browsing tasks           |
| Debug live pages                     | Scrape, test, fill forms from scratch |

## Core Workflow: Name What You Want

If you can describe the element in words — its label, its role and name, its
text — say so and act in one call. No snapshot, no refs, nothing to invalidate:

```bash
anima dominatrix find_role  --role button --name "Publish"        --perform click
anima dominatrix find_label --label "Email"  --perform fill --value "user@example.com"
anima dominatrix find_text  --text "Posts"                        --perform click
```

This is the fast path and should be your default for driving a page you can
describe. Each call re-queries the live DOM, so it survives navigations,
re-renders and dynamic content that would invalidate a ref.

**Reach for `snapshot` when you cannot name the target** — exploring an
unfamiliar page, or when several elements match and you need to pick one:

```bash
# 1. See what is on the page
anima dominatrix snapshot

# Output:
# Page: beehiiv Dashboard
# URL: https://app.beehiiv.com/dashboard
#
# @e1 [a] "Dashboard" href="/dashboard"
# @e2 [a] "Start writing" href="/posts/new"
# @e3 [a] "Posts" href="/posts"
# @e4 [button] "View site"
# @e5 [input type="email"] placeholder="Enter email"
# @e6 [button] "Submit"

# 2. Act on a specific one
anima dominatrix click --ref @e3
anima dominatrix fill  --ref @e5 --value "user@example.com"

# 3. Re-snapshot — refs are invalidated by navigation and DOM changes
anima dominatrix snapshot
```

**Rule of thumb**: describe it if you can, snapshot if you cannot. Refs are for
disambiguation and exploration, not for every interaction.

## Tabs, Sessions & Profiles — read this before navigating

Chrome is usually running **several profiles**, each connected as its own client, and
a tab ID only means something inside one profile. Two rules keep you out of trouble:

**1. Open your own tab. Never hijack one of Michael's.**

```bash
anima dominatrix navigate --url "https://example.com" --tabId new
# → { "tabId": 4821, "url": "...", "created": true, "profile": "kiliman@gmail.com" }
```

`--tabId new` opens a fresh tab and returns its ID. Without it, `navigate` drives
whatever tab is already in front — which may be something Michael is working in.

**2. After that, just omit `--tabId`.**

Every command carries the session ID automatically (from `$ANIMA_SESSION_ID`), and
DOMINATRIX remembers the tab your session opened. So this all lands in tab 4821:

```bash
anima dominatrix navigate --url "https://example.com/login" --tabId new
anima dominatrix snapshot            # ← same tab
anima dominatrix click --ref @e3     # ← same tab
anima dominatrix screenshot          # ← same tab
```

The binding is set by `navigate`, `new_tab`, `use_tab`, or any explicit numeric
`--tabId`. Read commands alone never pin the session, so `get_title` with no tab
bound still reports the tab Michael is actually looking at.

### Picking a profile

```bash
anima dominatrix list_profiles       # Connected profiles you can target
anima dominatrix navigate --url "https://example.com" --tabId new --profile kiliman@gmail.com
```

`navigate` and `new_tab` **refuse to guess** when more than one profile is connected
and the session has no tab yet — they fail with the profile list. Pass `--profile`
(label or ID prefix) to choose. Once a session is bound, its profile is implied.

### Switching between tabs

```bash
anima dominatrix session_tabs         # Tabs this session has worked in, newest first
anima dominatrix use_tab --tabId 4821 # Switch back to one of them
anima dominatrix close_tab            # Close the session's current tab
anima dominatrix close_tab --tabId 4821 # Close a specific one
```

`session_tabs` prunes tabs that have since been closed, and marks the current one.
**Close the tabs you opened** when you're done — they're Michael's browser, and
`close_tab` drops the tab from the session's list as it goes.

### Tab selectors

| `--tabId`   | Meaning                                                     |
| ----------- | ----------------------------------------------------------- |
| _(omitted)_ | The session's bound tab, else the side panel / active tab   |
| `new`       | Open a fresh tab (navigate / new_tab only) and bind to it   |
| `active`    | Force the profile's focused tab, ignoring any stale binding |
| `<number>`  | That exact tab, and bind the session to it                  |

## Commands

All commands go through `anima dominatrix <method>`.

### Snapshot & Page Info

```bash
# Interactive snapshot with @refs — for exploring or disambiguating
anima dominatrix snapshot
anima dominatrix snapshot --full        # Full a11y tree JSON (old behavior, large)
anima dominatrix snapshot --scope "#main"  # Scope to CSS selector
anima dominatrix snapshot --sources        # Include React component source info

# Content extraction
anima dominatrix get_text               # Page innerText (plain text, most efficient)
anima dominatrix get_text --ref @e5     # Text of specific element
anima dominatrix get_markdown           # Page as Markdown
anima dominatrix get_markdown --ref @e5 # Markdown of specific element
anima dominatrix get_url                # Current URL
anima dominatrix get_title              # Page title
anima dominatrix get_html               # Full page HTML
anima dominatrix get_html --selector "div.main"  # Scoped HTML
```

### Interaction (ref-based — when you need a specific element)

```bash
# Click — use @ref (preferred) or --selector fallback
anima dominatrix click --ref @e3
anima dominatrix click --selector "button.submit"

# Fill form fields
anima dominatrix fill --ref @e10 --value "hello"
anima dominatrix fill --selector "input[name=email]" --value "user@example.com"

# Checkbox / radio
anima dominatrix check --ref @e7
anima dominatrix uncheck --ref @e7

# Select dropdown
anima dominatrix select --ref @e5 --value "option-1"
```

### Semantic Find (locate + act in one call) — prefer this

```bash
anima dominatrix find_text --text "Posts" --perform click
anima dominatrix find_text --text "Email" --perform fill --value "user@example.com"
anima dominatrix find_label --label "Password" --perform fill --value "secret"
anima dominatrix find_role --role button --name "Submit" --perform click
anima dominatrix find_placeholder --placeholder "Search..." --perform fill --value "query"
```

**Matching is case-insensitive and partial**, so you can pass the readable part
of a label and ignore decoration. `--label "Your beehiiv handle"` matches a
field labelled `Your beehiiv handle *`.

| Command            | Matches                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `find_label`       | Exact `aria-label`, else `<label>` text containing yours (via `for=` or a wrapped input)                                                       |
| `find_role`        | Explicit `role=`, plus implicit roles (`a`→link, `button`→button, `textarea`→textbox, `select`→combobox). `--name` matches the accessible name |
| `find_text`        | An element's own visible text (not text inherited from children)                                                                               |
| `find_placeholder` | Placeholder text                                                                                                                               |

Two things to know:

- **`--perform` is required.** These commands always act; there is no
  locate-only mode. To inspect without touching anything, use `snapshot`.
- **The first visible match wins**, with no warning that others existed. When
  a description could match several elements, `snapshot` and act on a ref
  instead — that is what refs are for.

Only visible elements are considered, and a miss is a clear error
(`No element found with label: "..."`) rather than a silent no-op.

### Navigation & Scrolling

```bash
anima dominatrix navigate --url "https://example.com" --tabId new  # Own tab (preferred)
anima dominatrix navigate --url "https://example.com"              # Session's bound tab
anima dominatrix navigate --url "https://example.com" --tabId 4821 # A specific tab
anima dominatrix new_tab --url "https://example.com"               # Same as --tabId new
anima dominatrix new_tab                                           # Blank tab
anima dominatrix new_tab --url "https://example.com" --background   # Don't steal focus

anima dominatrix scroll_down --value 500      # Scroll down 500px (default: 300)
anima dominatrix scroll_up --value 300         # Scroll up
anima dominatrix scroll_to --ref @e5           # Scroll element into view
anima dominatrix scroll_to --position top      # Scroll to top
anima dominatrix scroll_to --position bottom   # Scroll to bottom
```

### Wait

```bash
anima dominatrix wait_for_element --selector "div.loaded"  # Wait for element
anima dominatrix wait_for_text --text "Success"            # Wait for text to appear
anima dominatrix wait_for_url --pattern "**/posts"         # Wait for URL change
anima dominatrix wait --ms 2000                            # Wait milliseconds
```

### React Source Inspection

```bash
anima dominatrix get_source --ref @e12             # Component ancestry + source for element
anima dominatrix get_source --selector ".my-button" # Same, via CSS selector
```

### Debugging

```bash
anima dominatrix exec --script "document.title = 'hi'"     # Execute JS
anima dominatrix eval --expression "document.title"         # Evaluate JS
anima dominatrix get_console                                # Console logs
anima dominatrix get_network                                # Network requests
anima dominatrix get_storage                                # localStorage/sessionStorage
anima dominatrix get_cookies                                # Cookies
anima dominatrix screenshot --out shot.png                  # Screenshot straight to a file
anima dominatrix screenshot                                 # ...or as a PNG data URL
```

### Running JavaScript

`exec` and `eval` do **not** run your code with the page's own `eval` — pages with
a strict CSP (beehiiv, GitHub, most banks) forbid that. Code runs through JailJS,
an AST interpreter, which only implements a subset of JavaScript.

**You can write modern JS.** The gateway transpiles to that subset before the
code reaches the page, so spread, `for..of`, destructuring, template literals,
`class`, optional chaining, and default/rest params all work.

Two things the transpiler cannot fix, because they are about what exists at
runtime rather than syntax:

**Only whitelisted globals exist.** `document`, `window`, `console`, `fetch`,
`JSON`, `Math`, `Date`, timers, the DOM event constructors, and the JS
built-ins (`Array`, `Object`, `String`, `Number`, `Promise`, `Symbol`). Anything
else — `localStorage`, `location`, `navigator` — is reached through `window`:

```bash
anima dominatrix eval --expression "window.location.href"
```

**There is no `hover` command.** Dispatch the event yourself:

```bash
anima dominatrix eval --expression "\
  document.querySelector('[data-tip]')\
    .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))"
```

That drives JS-based hover UI (tooltips, dropdown triggers). It does **not**
drive CSS `:hover` — a purely CSS tooltip cannot be captured this way, because
synthetic events don't change pseudo-class state.

**A method call evaluates its receiver twice.** This is a JailJS bug, not
something the transpiler can fix. `get().m()` runs `get()` **twice**; plain
property access (`get().p`) runs it once. So anything side-effecting in the
receiver position fires twice:

```js
// WRONG — pops two elements
stack.pop().toString();

// RIGHT — bind it first
var top = stack.pop();
top.toString();
```

Keep the receiver of a method call a plain variable or property chain and this
never bites. It is worth knowing about because the symptom is silently wrong
data rather than an error.

If an expression fails, the error comes from JailJS and names the AST node it
choked on (`Unhandled node type: X`). That means the construct reached the
interpreter untranspiled — worth reporting.

## React Source Mapping

Map DOM elements back to React component source files. Works on any React dev app — no additional libraries needed.

```bash
# Get source for a specific element
anima dominatrix get_source --ref @e12
# Returns: component name, file path, line number, full ancestry chain

# Enriched snapshot with source annotations
anima dominatrix snapshot --sources
# Each element shows its nearest React component + file path
# e.g. @e3 [button] "View site" <- Button (src/components/Header.tsx:15) → DashboardLayout
```

### Workflow: UI bug → source file

1. `anima dominatrix snapshot --sources` — see elements with component names
2. Identify the problematic element by its ref
3. `anima dominatrix get_source --ref @eN` — get full ancestry chain
4. Open the source file and fix the issue

### Requirements

- React app running in **dev mode** (`_debugSource` info is stripped in production builds)
- No additional libraries needed — reads React fiber internals directly from DOM
- Production builds will still show component names but without file paths

## Content Reading Strategy

| Method               | When to use                                                    | Output size     |
| -------------------- | -------------------------------------------------------------- | --------------- |
| `find_*`             | **Default for acting** — describe the element, act in one call | Tiny            |
| `snapshot`           | Exploring, or disambiguating several matches                   | ~200-400 tokens |
| `snapshot --sources` | Elements + React component names & source files                | ~300-600 tokens |
| `get_text`           | Quick content reading, search results                          | Medium          |
| `get_markdown`       | Structured content (articles, docs)                            | Medium          |
| `snapshot --full`    | Deep DOM inspection (rarely needed)                            | ~50,000+ tokens |
| `get_html`           | Specific element inspection                                    | Variable        |
| `screenshot --out`   | Visual verification, layout issues                             | Writes a file   |

## Reading Results

Every command prints its result as JSON — the value itself, with no wrapper:

```bash
anima dominatrix get_url        # "https://example.com/"
anima dominatrix new_tab …      # { "tabId": 124530013, "url": "…", … }
anima dominatrix list_tabs      # [ { "id": …, "url": … }, … ]
```

**Failures are errors, not results.** A command that cannot do what you asked
exits non-zero and prints `Error: …` — including a `find_*` that matched
nothing, or a click on an element that is not there. So `cmd && next` is safe,
and there is no `success` field to check.

**`--out <path>` writes the result to a file** instead of printing it, decoding
a base64 data URI to real bytes on the way. Mainly for screenshots:

```bash
anima dominatrix screenshot --out shot.png
# Wrote shot.png (image/png, 21186 bytes)
```

## Ref Lifecycle

- Refs (`@e1`, `@e2`, ...) map directly to DOM element references in the content script
- **Invalidated** when the page navigates or content changes significantly
- Always re-snapshot after: clicking links, submitting forms, or waiting for dynamic content
- Skip the whole cycle where you can: `find_*` re-queries the DOM on every call, so there is nothing to invalidate
- The ancestor walking system handles cases like clicking a `<span>` inside an `<a>` — it finds the nearest interactive parent automatically

## Notes

- **Real browser**: Controls actual Chrome with real profiles, cookies, and auth — not sandboxed
- **CSP bypass**: Script execution uses JailJS (AST interpreter) for sites with strict CSP — see [Running JavaScript](#running-javascript) for what that constrains
- **Resilient injection**: If the content script isn't loaded (page reload, manual navigation), it's automatically injected on demand
- **Console/Network**: Collected passively from content script load — retrieve history anytime
- **Tab binding**: Per session, persisted across gateway restarts. `session_tabs` shows it
- **Profile routing**: Each command is addressed to one profile's extension instance; the
  others ignore it. Profiles are identified by their signed-in email, or `chrome-<id>` when
  signed out — `list_profiles` shows both
- **Side panel context**: With no session binding and no `--tabId`, an open Anima side panel's
  tab wins over the active tab. Use `--tabId active` to override that
