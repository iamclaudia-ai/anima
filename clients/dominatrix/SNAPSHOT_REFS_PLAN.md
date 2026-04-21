# DOMINATRIX: Snapshot Refs & Agent-Friendly Interaction

## Problem

Currently, interacting with page elements from the CLI requires:

1. Running `anima dominatrix snapshot` → get 500KB+ JSON a11y tree
2. Grepping through it to find the right element
3. Guessing a CSS selector for `click`/`fill`
4. Often failing because the selector doesn't match or hits the wrong element (e.g., clicking a `<span>` instead of its parent `<a>`)

This is unusable for AI agents. We need the `agent-browser` interaction model: **snapshot → ref → act → re-snapshot**.

## Solution

Port the ref-based snapshot system from [agent-browser](~/Projects/oss/vercel-labs/agent-browser/src/snapshot.ts) into the dominatrix content script. Since we can't use Playwright's proprietary `ariaSnapshot()`, we build our own DOM walker.

## Architecture

```
Current:
  CLI → gateway → background.ts → content-script.ts → full a11y tree JSON (huge)
  CLI → gateway → background.ts → content-script.ts → querySelector(css) → click (fragile)

Proposed:
  CLI → gateway → background.ts → content-script.ts → compact ref list (small)
  CLI → gateway → background.ts → content-script.ts → refMap[@e2] → element → click (reliable)
```

The content script maintains a `refMap: Map<string, Element>` that maps `@e1`, `@e2`, etc. directly to DOM element references. This is simpler than agent-browser's approach (which stores selectors and re-queries) because we have persistent content script state.

## Commands (New & Updated)

All commands follow the gateway convention: `dominatrix.method_name` with explicit named params via zod schemas. The CLI maps these as `anima dominatrix method_name --param value`.

### Snapshot & Page Info

```bash
# Interactive snapshot with refs (NEW — the main addition)
anima dominatrix snapshot              # Interactive elements with @refs (new default)
anima dominatrix snapshot --full       # Full a11y tree JSON (old behavior)
anima dominatrix snapshot --scope "#main"  # Scope to CSS selector

# Getters (renamed from text/markdown for consistency)
anima dominatrix get_text              # Page innerText (was: text)
anima dominatrix get_text --ref @e5    # Text of specific element
anima dominatrix get_markdown          # Page as Markdown (was: markdown)
anima dominatrix get_url               # Current URL
anima dominatrix get_title             # Page title
anima dominatrix get_html              # Full page HTML (was: html)
anima dominatrix get_html --selector "div.main"  # Scoped HTML
```

**Gateway methods:**

| Method                    | Schema              | Description                             |
| ------------------------- | ------------------- | --------------------------------------- |
| `dominatrix.snapshot`     | `{ full?, scope? }` | Interactive refs (default) or full tree |
| `dominatrix.get_text`     | `{ ref? }`          | Plain text of page or element           |
| `dominatrix.get_markdown` | `{ ref? }`          | Markdown of page or element             |
| `dominatrix.get_url`      | `{}`                | Current page URL                        |
| `dominatrix.get_title`    | `{}`                | Current page title                      |
| `dominatrix.get_html`     | `{ selector? }`     | HTML of page or element                 |

### Interaction (ref-based)

```bash
# Click — supports @ref (preferred) or --selector fallback
anima dominatrix click --ref @e3                    # Click "Posts" link
anima dominatrix click --selector "button.submit"   # CSS fallback

# Fill form fields
anima dominatrix fill --ref @e10 --value "hello"
anima dominatrix fill --selector "input[name=email]" --value "user@example.com"

# Checkbox / radio
anima dominatrix check --ref @e7
anima dominatrix uncheck --ref @e7

# Select dropdown
anima dominatrix select --ref @e5 --value "option-1"
```

**Gateway methods:**

| Method               | Schema                       | Description            |
| -------------------- | ---------------------------- | ---------------------- |
| `dominatrix.click`   | `{ ref?, selector? }`        | Click element          |
| `dominatrix.fill`    | `{ ref?, selector?, value }` | Fill form field        |
| `dominatrix.check`   | `{ ref?, selector? }`        | Check checkbox         |
| `dominatrix.uncheck` | `{ ref?, selector? }`        | Uncheck checkbox       |
| `dominatrix.select`  | `{ ref?, selector?, value }` | Select dropdown option |

### Semantic Find (NEW)

Find elements by semantic attributes and perform actions. Each `find_*` method locates the element and executes an action in one call.

```bash
anima dominatrix find_text --text "Posts" --action click
anima dominatrix find_text --text "Email" --action fill --value "user@example.com"
anima dominatrix find_label --label "Password" --action fill --value "secret"
anima dominatrix find_role --role button --name "Submit" --action click
anima dominatrix find_placeholder --placeholder "Search..." --action fill --value "query"
```

**Gateway methods:**

| Method                        | Schema                            | Description              |
| ----------------------------- | --------------------------------- | ------------------------ |
| `dominatrix.find_text`        | `{ text, action, value? }`        | Find by visible text     |
| `dominatrix.find_label`       | `{ label, action, value? }`       | Find by label/aria-label |
| `dominatrix.find_role`        | `{ role, name?, action, value? }` | Find by ARIA role        |
| `dominatrix.find_placeholder` | `{ placeholder, action, value? }` | Find by placeholder      |

### Navigation & Scrolling

```bash
# Navigate
anima dominatrix navigate --url "https://example.com"

# Scroll
anima dominatrix scroll_down --value 500     # Scroll down 500px (default: 300)
anima dominatrix scroll_up --value 300        # Scroll up
anima dominatrix scroll_to --ref @e5          # Scroll element into view
anima dominatrix scroll_to --position top     # Scroll to top
anima dominatrix scroll_to --position bottom  # Scroll to bottom
```

**Gateway methods:**

| Method                   | Schema                | Description                   |
| ------------------------ | --------------------- | ----------------------------- |
| `dominatrix.navigate`    | `{ url }`             | Navigate tab to URL           |
| `dominatrix.scroll_down` | `{ value? }`          | Scroll down by pixels         |
| `dominatrix.scroll_up`   | `{ value? }`          | Scroll up by pixels           |
| `dominatrix.scroll_to`   | `{ ref?, position? }` | Scroll to element or position |

### Wait (NEW)

```bash
anima dominatrix wait_for_element --selector "div.loaded"  # Wait for element
anima dominatrix wait_for_text --text "Success"            # Wait for text to appear
anima dominatrix wait_for_url --pattern "**/posts"         # Wait for URL change
anima dominatrix wait --ms 2000                            # Wait milliseconds
```

**Gateway methods:**

| Method                        | Schema                   | Description      |
| ----------------------------- | ------------------------ | ---------------- |
| `dominatrix.wait_for_element` | `{ selector, timeout? }` | Wait for element |
| `dominatrix.wait_for_text`    | `{ text, timeout? }`     | Wait for text    |
| `dominatrix.wait_for_url`     | `{ pattern, timeout? }`  | Wait for URL     |
| `dominatrix.wait`             | `{ ms }`                 | Wait fixed time  |

### Debugging (existing, renamed)

```bash
anima dominatrix exec --script "document.title = 'hi'"    # Execute JS (unchanged)
anima dominatrix eval --expression "document.title"        # Evaluate JS (unchanged)
anima dominatrix get_console                               # Console logs (was: console)
anima dominatrix get_network                               # Network requests (was: network)
anima dominatrix get_storage                               # localStorage/sessionStorage (was: storage)
anima dominatrix get_cookies                               # Cookies (was: cookies)
anima dominatrix screenshot                                # Screenshot (unchanged)
```

### Snapshot Output Format

The default `snapshot` (interactive mode) returns compact text:

```
Page: beehiiv Dashboard
URL: https://app.beehiiv.com/dashboard

@e1 [a] "Dashboard"
@e2 [a] "Start writing"
@e3 [a] "Posts"
@e4 [a] "Audience"
@e5 [a] "Grow"
@e6 [a] "Monetize"
@e7 [button] "View site"
@e8 [input type="email"] placeholder="Enter email"
@e9 [button] "Submit"
@e10 [clickable] "Copy" (cursor:pointer)
```

This is ~200-400 tokens vs ~50,000+ for the full a11y tree JSON.

## Implementation Plan

### Phase 0: Resilient Content Script Injection

**Problem**: `chrome.tabs.sendMessage()` fails with "Could not establish connection" when the content script hasn't loaded yet — happens on manual navigation, new tabs, or page reloads before `document_idle`.

**Fix**: Add `chrome.scripting.executeScript()` fallback in the background worker.

**File: `clients/dominatrix/src/background.ts`**

1. Add `scripting` permission to `manifest.json` (if not already present)
2. Wrap all `chrome.tabs.sendMessage()` calls with a resilient dispatcher:

```ts
async function sendToContentScript(tabId: number, message: any): Promise<any> {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    // Content script not loaded — inject it on demand
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"],
    });
    // Brief delay for script initialization
    await new Promise((resolve) => setTimeout(resolve, 100));
    return await chrome.tabs.sendMessage(tabId, message);
  }
}
```

3. Content script should be idempotent — guard against double-injection:

```ts
// content-script.ts — top of file
if (window.__dominatrix_loaded) {
  // Already injected, skip initialization
} else {
  window.__dominatrix_loaded = true;
  // ... initialize console hooks, message listeners, etc.
}
```

4. Replace all direct `chrome.tabs.sendMessage()` calls in `background.ts` with `sendToContentScript()`

**Why not CDP?** Using `chrome.debugger` would work but shows an ugly yellow "this browser is being debugged" banner. The `executeScript` fallback is invisible to the user and handles all the failure cases we hit (navigating to beehiiv, page reloads, new tabs).

### Phase 1: Ref System in Content Script

**File: `clients/dominatrix/src/content-script.ts`**

Add:

1. `refMap: Map<string, Element>` — maps ref IDs to DOM elements
2. `refCounter: number` — sequential counter, resets on each snapshot
3. `getInteractiveSnapshot()` — walks DOM, builds ref list, returns compact text
4. `resolveRef(ref: string): Element | null` — looks up element from refMap
5. `getImplicitRole(element: Element): string` — determines ARIA role from tag name
6. `findCursorInteractiveElements()` — adapted from agent-browser's `snapshot.ts:161-256`

### Phase 2: Updated Message Handlers in Content Script

**File: `clients/dominatrix/src/content-script.ts`**

Update/add message handlers to match new gateway actions:

1. `snapshot` → return interactive refs by default, `--full` for old JSON tree
2. `click` → resolve `ref` OR `selector`, with ancestor walking for refs
3. `fill` → resolve `ref` OR `selector`, proper event dispatching (focus → clear → input → change)
4. New handlers: `check`, `uncheck`, `select`
5. New handlers: `find_text`, `find_label`, `find_role`, `find_placeholder` (locate + act)
6. New handlers: `scroll_down`, `scroll_up`, `scroll_to`
7. New handlers: `wait_for_element`, `wait_for_text`, `wait_for_url`, `wait`
8. Rename existing: `getText` → `get_text`, `getMarkdown` → `get_markdown`, etc.
9. New handlers: `get_url`, `get_title` (trivial — `location.href`, `document.title`)

### Phase 3: Gateway Extension Updates

**File: `extensions/dominatrix/src/index.ts`**

Update method definitions and schemas to match the new flat `dominatrix.method_name` convention:

1. **Update existing methods:**
   - `dominatrix.snapshot` — add `full` boolean, `scope` string params
   - `dominatrix.click` — add `ref` string param alongside `selector`
   - `dominatrix.fill` — add `ref` string param alongside `selector`
   - Rename: `dominatrix.text` → `dominatrix.get_text`, etc.

2. **Add new methods (with zod schemas):**
   - `dominatrix.get_url`, `dominatrix.get_title`
   - `dominatrix.check`, `dominatrix.uncheck`, `dominatrix.select`
   - `dominatrix.find_text`, `dominatrix.find_label`, `dominatrix.find_role`, `dominatrix.find_placeholder`
   - `dominatrix.scroll_down`, `dominatrix.scroll_up`, `dominatrix.scroll_to`
   - `dominatrix.wait_for_element`, `dominatrix.wait_for_text`, `dominatrix.wait_for_url`, `dominatrix.wait`

3. **Update `sendCommand` routing** — map method names to content script actions

No CLI changes needed — the CLI is auto-generated from zod schemas.

### Phase 4: react-grab Integration (DOM → React Source Mapping)

**Goal**: Given a `@ref` from a snapshot, return the React component name and source file path. Enables the workflow: "I see a bug on this button" → `get_source --ref @e35` → `PostEditor.tsx:87`.

**Prerequisites**: The target app must load react-grab in dev mode (script tag, npm import, or `<ReactGrab />` component). Dominatrix does NOT bundle react-grab — it just consumes the API that react-grab exposes on the page.

**How it works**:

1. App loads react-grab → installs `window.__REACT_GRAB__` API
2. User runs `anima dominatrix get_source --ref @e35`
3. Content script resolves `@e35` → DOM element from refMap
4. Calls `window.__REACT_GRAB__.getSource(element)`
5. Returns `{ filePath, lineNumber, componentName }`

**What react-grab gives us** (from clipboard output):

```
@<Card>
<div class="border group/ui...">
  ...
  in Card (at /ui/Card/Card.tsx)
  in ChartAreaInteractive (at /src/routes/dashboard/components/SubscriberEventsWidget/SubscriberEventsWidget.tsx)
  in AnalyticsSection (at /src/routes/dashboard/components/AnalyticsSection/AnalyticsSection.tsx)
```

It returns the **full component ancestry chain** — from the immediate wrapper up through the page section. This is critical for knowing whether to fix the UI primitive or the feature component.

**New command**:

```bash
anima dominatrix get_source --ref @e12
# → {
#   "components": [
#     { "name": "Card", "file": "/ui/Card/Card.tsx" },
#     { "name": "ChartAreaInteractive", "file": "/src/routes/dashboard/components/SubscriberEventsWidget/SubscriberEventsWidget.tsx" },
#     { "name": "AnalyticsSection", "file": "/src/routes/dashboard/components/AnalyticsSection/AnalyticsSection.tsx" }
#   ]
# }

anima dominatrix get_source --selector ".my-button"
# → same, but via CSS selector

# Bulk: get source for all interactive elements (enriched snapshot)
anima dominatrix snapshot --sources
# → @e1 [button] "Submit" ← Card → ChartAreaInteractive (SubscriberEventsWidget.tsx) → AnalyticsSection
# → @e2 [a] "Dashboard" ← NavLink (Sidebar.tsx)
```

**Gateway method**:

| Method                  | Schema                | Description                              |
| ----------------------- | --------------------- | ---------------------------------------- |
| `dominatrix.get_source` | `{ ref?, selector? }` | Get React component ancestry for element |

**Content script handler** (`get_source` action):

```ts
case "get_source": {
  const el = resolveElement(message.ref, message.selector);
  if (!window.__REACT_GRAB__) {
    return { success: false, error: "react-grab not loaded on this page (dev mode only)" };
  }
  // copyElement returns the full ancestry text that react-grab puts on clipboard
  // We can parse it or use getSource/getDisplayName to walk the fiber tree
  const source = await window.__REACT_GRAB__.getSource(el);
  const name = window.__REACT_GRAB__.getDisplayName(el);
  // TODO: Need to check if react-grab API exposes full ancestry or just nearest component.
  // If only nearest, we may need to use bippy's getFiberFromHostInstance() and walk
  // fiber.return chain ourselves to build the full ancestry.
  return {
    success: true,
    data: {
      componentName: name || null,
      filePath: source?.filePath || null,
      lineNumber: source?.lineNumber || null,
      // Full ancestry if available:
      // components: [{ name, file }, ...]
    }
  };
}
```

**Note**: The `getSource()` API may only return the nearest component. The full ancestry chain (as seen in the clipboard output) might require walking the React fiber tree via bippy's `getFiberFromHostInstance()` → traverse `fiber.return` chain → collect composite fiber names + `_debugSource` at each level. We should test what the API exposes and fall back to fiber walking if needed.

**Snapshot `--sources` flag**: When set, after building the ref list, iterate each ref's element and call `getSource()` to append source info to the output line. Show the nearest meaningful component name (skip generic primitives like `div`, `span`). This is slower (one async call per element) so it's opt-in.

**What we DON'T do**:

- Don't bundle react-grab in the extension
- Don't inject react-grab into pages
- Don't touch the react-grab UI (user keeps the hover overlay for manual use)
- Don't try to work on production builds (graceful "not available" error)

**Files to modify**:

- `clients/dominatrix/src/content-script.ts` — add `get_source` handler, optional source enrichment in snapshot
- `extensions/dominatrix/src/index.ts` — add `dominatrix.get_source` method + schema, update `dominatrix.snapshot` schema with `sources` boolean

### Phase 5: Controlling-the-Browser Skill Update

**File: `~/.claude/skills/controlling-the-browser/SKILL.md`**

Rewrite to document the new ref-based workflow:

```bash
# Core workflow: snapshot → ref → act → re-snapshot
anima dominatrix snapshot                    # Get interactive elements with @refs
anima dominatrix click --ref @e3             # Click by ref
anima dominatrix fill --ref @e10 --value "text"  # Fill by ref
anima dominatrix snapshot                    # Re-snapshot after interaction
```

## Key Design Decisions

### Direct Element References vs Stored Selectors

Unlike agent-browser (which stores selectors and re-queries), we store **direct DOM element references** in the content script. This is:

- **Faster**: No re-querying
- **More reliable**: No selector ambiguity
- **Simpler**: No need for nth disambiguation

**Tradeoff**: Refs are invalidated when the page navigates or content script reloads. Same as agent-browser — re-snapshot after navigation.

### Implicit Role Mapping

Since we don't have Playwright's `ariaSnapshot()`, we need our own role inference:

```
<a>        → link
<button>   → button
<input>    → textbox (or checkbox, radio, etc. based on type)
<select>   → combobox
<textarea> → textbox
<details>  → group
<summary>  → button
[role="x"] → x (explicit always wins)
```

### Ancestor Walking for Clicks

When clicking `@e3` which points to a `<span>`, walk up to find the nearest interactive ancestor (`<a>`, `<button>`, or element with `onclick`/`role="button"`). This fixes the beehiiv "Posts" click issue.

### Ref Output Format

Follow agent-browser's compact format:

```
@e1 [tag] "visible text"
@e2 [input type="email"] placeholder="Enter email"
@e3 [button] "Submit"
```

This is ~200-400 tokens vs ~50,000+ tokens for the full a11y tree JSON.

## Files to Modify

| File                                                | Changes                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `clients/dominatrix/manifest.json`                  | Add `scripting` permission                                              |
| `clients/dominatrix/src/background.ts`              | Resilient `sendToContentScript()` dispatcher                            |
| `clients/dominatrix/src/content-script.ts`          | Idempotent init guard, ref system, DOM walker, all new/updated handlers |
| `extensions/dominatrix/src/index.ts`                | New method schemas (zod), method routing, renamed methods               |
| `~/.claude/skills/controlling-the-browser/SKILL.md` | Rewrite for ref-based workflow                                          |

Note: CLI is auto-generated from zod schemas — no separate CLI changes needed.

## Reference

- agent-browser snapshot.ts: `~/Projects/oss/vercel-labs/agent-browser/src/snapshot.ts`
- agent-browser commands ref: `~/.claude/skills/browsing-the-web/references/commands.md`
- agent-browser snapshot ref: `~/.claude/skills/browsing-the-web/references/snapshot-refs.md`
- react-grab: `https://github.com/aidenybai/react-grab`
- react-grab API: `window.__REACT_GRAB__` — `getSource(element)`, `getDisplayName(element)`
- bippy (react-grab core): `https://github.com/nicholasgasior/bippy` — lightweight React fiber access
