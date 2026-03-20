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

## Core Workflow: Snapshot → Ref → Act → Re-snapshot

```bash
# 1. Take a snapshot to get interactive elements with @refs
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

# 2. Interact using @refs (reliable, no CSS selector guessing)
anima dominatrix click --ref @e3              # Click "Posts" link
anima dominatrix fill --ref @e5 --value "user@example.com"  # Fill email

# 3. Re-snapshot after navigation/interaction (refs are invalidated)
anima dominatrix snapshot
```

**Key principle**: Always snapshot before interacting. Refs are invalidated on page navigation or dynamic changes — re-snapshot to get fresh refs.

## Commands

All commands go through `anima dominatrix <method>`. When `--tab-id` is omitted, the active tab is used.

### Snapshot & Page Info

```bash
# Interactive snapshot with @refs (DEFAULT — use this!)
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

### Interaction (ref-based — preferred)

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

### Semantic Find (locate + act in one call)

```bash
anima dominatrix find_text --text "Posts" --perform click
anima dominatrix find_text --text "Email" --perform fill --value "user@example.com"
anima dominatrix find_label --label "Password" --perform fill --value "secret"
anima dominatrix find_role --role button --name "Submit" --perform click
anima dominatrix find_placeholder --placeholder "Search..." --perform fill --value "query"
```

### Navigation & Scrolling

```bash
anima dominatrix navigate --url "https://example.com"

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
anima dominatrix screenshot                                 # Screenshot as PNG data URL
```

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

| Method               | When to use                                        | Output size     |
| -------------------- | -------------------------------------------------- | --------------- |
| `snapshot`           | **Default** — find interactive elements with @refs | ~200-400 tokens |
| `snapshot --sources` | Elements + React component names & source files    | ~300-600 tokens |
| `get_text`           | Quick content reading, search results              | Medium          |
| `get_markdown`       | Structured content (articles, docs)                | Medium          |
| `snapshot --full`    | Deep DOM inspection (rarely needed)                | ~50,000+ tokens |
| `get_html`           | Specific element inspection                        | Variable        |
| `screenshot`         | Visual verification, layout issues                 | PNG data URL    |

## Ref Lifecycle

- Refs (`@e1`, `@e2`, ...) map directly to DOM element references in the content script
- **Invalidated** when the page navigates or content changes significantly
- Always re-snapshot after: clicking links, submitting forms, or waiting for dynamic content
- The ancestor walking system handles cases like clicking a `<span>` inside an `<a>` — it finds the nearest interactive parent automatically

## Notes

- **Real browser**: Controls actual Chrome with real profiles, cookies, and auth — not sandboxed
- **CSP bypass**: Script execution uses JailJS (AST interpreter) for sites with strict CSP
- **Resilient injection**: If the content script isn't loaded (page reload, manual navigation), it's automatically injected on demand
- **Console/Network**: Collected passively from content script load — retrieve history anytime
- **Side panel context**: When the Anima side panel is open, commands without `--tabId` target that tab
