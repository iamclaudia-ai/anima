# Web Bundler

How the gateway builds and serves the browser-side code: the SPA shell, shared
vendor bundles, and per-extension bundles loaded dynamically at runtime.

## Why this exists

Originally the gateway statically imported every extension's `routes.ts` via a
generated index file (`extension-web-contributions.generated.ts`) and let Bun's
implicit HTML auto-bundling stitch everything together. That worked, but it
meant the gateway had a **compile-time dependency on every extension**, with
`@anima/ext-*` workspace deps in `packages/gateway/package.json` that had to be
edited every time an extension was added or removed.

The dynamic bundler removes that coupling. The gateway's `package.json` no
longer mentions any extensions; it discovers them at runtime by scanning
`extensions/*/src/routes.ts`. The browser SPA fetches a list of contribution
URLs at startup and dynamic-imports each one. A new extension drop-in is just:

1. Create `extensions/<id>/src/routes.ts` with a `default` export.
2. Restart the gateway.

No gateway source edits, no generator runs, no manual route registration.

## The three bundles

```
                   ┌────────────────────────────────────┐
                   │   /vendor/<slug>.js  (vendor)      │
                   │   react, react-dom, @anima/ui      │
                   │   Built once at startup            │
                   └──────────────▲─────────────────────┘
                                  │ importmap resolves
                                  │ bare imports
   ┌──────────────────┐           │           ┌───────────────────────────┐
   │  /spa.js  (SPA)  │───────────┴───────────│ /extensions/<id>/         │
   │  Web shell       │                       │   web-bundle.js (ext)     │
   │  Lazy-builds at  │                       │ Lazy-builds on first hit  │
   │  startup         │                       │ Cached in memory          │
   └──────────────────┘                       └───────────────────────────┘
```

All three bundles **externalize the same shared deps**. The browser uses an
importmap (declared in `index.html`) to resolve bare specifiers like
`"react"` and `"@anima/ui"` to the same `/vendor/<slug>.js` URL — so every
bundle ends up with **one shared module instance** for each external.

This is the single most important property of the design: without it, the SPA
and extensions would each get their own copy of `@anima/ui`, which means their
own copy of the `Router` and `GatewayClient` React contexts, which means
extension hooks like `useRouter()` would return null.

### SPA bundle (`/spa.js` + `/spa.css`)

Built by `packages/gateway/src/web/spa-bundler.ts` from `web/index.tsx`. The
SPA is the static shell: it bootstraps React, fetches the contribution list,
dynamic-imports each extension, aggregates the routes/panels/layouts, then
renders.

The CSS is produced by `bun-plugin-tailwind` running over the source. Tailwind
4's content scanner picks up extension classes via an `@source` directive in
`packages/ui/src/styles/index.css`:

```css
@source "../../../../extensions/*/src/**/*.{ts,tsx}";
```

Without `@source`, Tailwind's import-graph scanner would miss extension
components (since the SPA no longer statically reaches them).

### Vendor bundles (`/vendor/<slug>.js`)

Built by `packages/gateway/src/web/vendor-bundler.ts`. One bundle per shared
specifier:

| URL                                | Specifier               | Externalizes               |
| ---------------------------------- | ----------------------- | -------------------------- |
| `/vendor/react.js`                 | `react`                 | —                          |
| `/vendor/react-jsx-runtime.js`     | `react/jsx-runtime`     | (inlines React, see below) |
| `/vendor/react-jsx-dev-runtime.js` | `react/jsx-dev-runtime` | (inlines React)            |
| `/vendor/react-dom.js`             | `react-dom`             | `react`                    |
| `/vendor/react-dom-client.js`      | `react-dom/client`      | `react`, `react-dom`       |
| `/vendor/anima-ui.js`              | `@anima/ui`             | all React entries          |

Externals form a DAG — a vendor bundle for X never externalizes a downstream
package that depends on X (otherwise we'd have a cycle).

### Extension bundles (`/extensions/<id>/web-bundle.js`)

Built by `packages/gateway/src/web/extension-bundler.ts` from
`extensions/<id>/src/routes.ts`. Each extension externalizes the same
`SHARED_EXTERNALS` list as the SPA, so extension code, SPA code, and vendor
code all share one React instance.

## The shared-externals contract

```ts
// packages/gateway/src/web/extension-bundler.ts
export const SHARED_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "@anima/ui",
];
```

What's in this list and why:

- **React itself, react-dom, react-dom/client** — must be shared because they
  hold reconciler state, hook fiber lists, root containers, etc. Two React
  instances = broken hooks.
- **`@anima/ui`** — must be shared because it owns React contexts (Router,
  GatewayClient). Components from different `@anima/ui` instances can't see
  each other's providers.
- **`react/jsx-runtime` and `react/jsx-dev-runtime`** — listed for SPA
  consumption (the SPA externalizes them when bundling extensions). The
  vendor bundles for these specifically _do not_ externalize React (see
  "Bun quirks" below).

What's deliberately NOT in this list:

- **`@anima/shared`** — uses `node:crypto` and other Node-only APIs that
  break a browser build. Extensions inline whatever browser-safe slices
  they need (mostly types, which are erased anyway).
- **`zod`, `react-markdown`, `dockview`, etc.** — currently inlined per
  extension. They don't hold runtime singletons that need to be shared, so
  duplication is wasteful but not broken. Future optimization can promote
  them if bundle size becomes an issue.

## How named exports work (the auto-discovery trick)

React, react-dom, and most of the npm registry are still **CommonJS**. Bun's
default `export * from "<cjs-module>"` emits this to the bundle:

```js
var exports_react = {};
__reExport(exports_react, __toESM(require_react(), 1));
```

That puts everything onto a private object via `__reExport` but **never emits
ESM named exports**. So `import { Fragment } from "react"` would fail at
module evaluation with "does not provide an export named Fragment."

The fix: use **explicit re-exports** (`export { Fragment, useState, ... } from
"react"`). Bun's CJS-interop path for explicit names emits proper ESM bindings.

Listing every name by hand is brittle (React adds APIs across versions). So
`vendor-bundler.ts` does **runtime discovery**:

```ts
async function discoverNamedExports(specifier: string): Promise<string[]> {
  const mod = (await import(specifier)) as Record<string, unknown>;
  return Object.keys(mod).filter((key) => key !== "default");
}
```

The gateway dynamic-imports each specifier in its own (Bun) runtime,
`Object.keys` the namespace, and writes those names into the entry file:

```ts
// .web-vendor-entries/react.ts (generated, gitignored)
export { Children, Component, Fragment /* ...43 names */ } from "react";
export { default } from "react";
```

This is robust to React version upgrades — new APIs are auto-discovered on
the next gateway start.

## Bun quirks (lessons learned the hard way)

This subsystem was built against several real Bun behaviors that aren't
obvious from the docs. Future debugging will be much faster if you remember
these.

### 1. `Bun.build({ external: ["react"] })` does prefix matching

`external: ["react"]` also externalizes `react/jsx-runtime`, which would
turn the jsx-runtime vendor bundle into an infinite-loop re-export. We need
**exact** specifier matching, which means a custom plugin:

```ts
export function exactExternalsPlugin(specifiers: readonly string[]): Bun.BunPlugin {
  const set = new Set(specifiers);
  const escaped = specifiers.map((s) => s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const filter = new RegExp(`^(${escaped.join("|")})$`);
  return {
    name: "exact-externals",
    setup(build) {
      build.onResolve({ filter }, (args) => {
        if (set.has(args.path)) return { path: args.path, external: true };
        return undefined;
      });
    },
  };
}
```

### 2. `onResolve({ filter: /.*/ })` breaks barrel-import tree-shaking

A previous version of the plugin used `filter: /.*/` to inspect every
import in the dep graph. That interfered with Bun's barrel-import optimization
for packages like `lucide-react` (3,000+ icons, each a separate file with
`sideEffects: false`). Symptom: the bundle contained `default<N>` references
to icons that were never declared, because Bun's tree-shaker dropped the
icon source files while keeping references to them in consuming code.

**Always narrow plugin filters** to only the specifiers you actually care
about. The exact-match filter above keeps Bun's normal resolution pipeline
untouched for everything else.

### 3. `export * from "<cjs>"` doesn't emit ESM named exports

Covered above in "How named exports work." Always use explicit
`export { name } from "..."` syntax for CJS sources.

### 4. Bun lifts `var X = require("X")` to `import * as X` (immutable)

When you externalize `react` from a CJS file, Bun rewrites
`var React = require("react")` into `import * as React from "react"`. The
ESM binding is **immutable** — but React's own `react/jsx-dev-runtime`
source has this CJS pattern:

```js
var React = require("react");
// ... uses React for internals access ...
React = {
  react_stack_bottom_frame: function (cb) {
    return cb();
  },
};
```

That reassignment throws `Assignment to constant variable` at module
evaluation. **Workaround**: don't externalize React from the jsx-runtime
bundles. They get an inlined React copy. This is safe because:

- `$$typeof` element tags use `Symbol.for("react.*")` (globally cached
  across React copies — same Symbol identity)
- jsx-runtime only constructs element data structures; no hook or
  reconciler state ever touches its private React copy
- The actual rendering pipeline runs entirely against the shared
  `/vendor/react.js`

### 5. `import "./web/index.html"` is HTML magic mode by default

`import index from "./web/index.html"` returns a special handler that
auto-bundles `<script src="./foo.tsx">` references. With Phase 2's switch
to explicit bundling (`<script src="/spa.js">`), there's no source for
Bun to auto-bundle and the magic mode chokes with 500 "Build Failed."

**Fix**: import as a plain file with `with { type: "file" }` and serve
the bytes directly:

```ts
// @ts-ignore - Bun's file import syntax
import indexHtml from "./web/index.html" with { type: "file" };
// ...
"/*": () => new globalThis.Response(Bun.file(indexHtml as unknown as string), {
  headers: { "Content-Type": "text/html; charset=utf-8" },
}),
```

### 6. `Bun.serve`'s `routes` map runs before `fetch()`

A `"/*"` wildcard route catches `/ws` upgrade requests before the
`fetch(req, server)` handler gets a chance to call `server.upgrade()`.
**Always** register `/ws` (and any other path that needs special handling)
as an explicit route, with `(req, server) => Response` signature.

### 7. Vendor entry files must live inside the project tree

`Bun.build` resolves modules via `node_modules` walk from the entrypoint's
directory. Stub entry files in `/tmp/...` can't find workspace packages.
We write them to `packages/gateway/.web-vendor-entries/` (gitignored) so
the workspace's `node_modules` is reachable.

## Adding a new shared dependency

Currently rare — most npm packages don't hold runtime singletons and are
fine to inline per bundle. But if you find a package whose React contexts
or instance-state need to be shared (e.g., a state library, a router lib),
add it to `SHARED_EXTERNALS` and `VENDOR_SPECS`:

1. Add the bare specifier to `SHARED_EXTERNALS` in `extension-bundler.ts`.
2. Add a `VendorSpec` entry in `vendor-bundler.ts`. Externals list should
   include any _other_ shared deps the new package depends on.
3. Add the importmap entry in `packages/gateway/src/web/index.html`:
   ```html
   <script type="importmap">
     { "imports": { ..., "<specifier>": "/vendor/<slug>.js" } }
   </script>
   ```

That's it. Restart the gateway and the new vendor bundle is built at
startup, available via importmap to every extension and the SPA.

## Future: external extensions via `bun add`

The current setup assumes extensions live in the monorepo and share the
catalog (`packages/*` workspace deps). When external extensions become a
thing — `bun add @some-org/anima-extension-x` — we'll need a few changes:

### Peer dependencies

External extensions should declare shared deps as `peerDependencies` so
their consumer (the user's Anima install) is responsible for providing
them, and `bun add` doesn't pull in a duplicate copy:

```json
{
  "name": "@some-org/anima-extension-x",
  "peerDependencies": {
    "@anima/ui": "*",
    "@anima/shared": "*",
    "react": "*",
    "react-dom": "*"
  },
  "dependencies": {
    "lucide-react": "^0.563.0"
  }
}
```

The gateway's bundle pipeline then externalizes the peer deps the same way
it does for monorepo extensions — they all resolve to the same vendor URLs.

### Per-extension CSS

In the monorepo today, all Tailwind output is bundled into the global
`/spa.css` because `@source` globs over `extensions/*/src`. External
extensions installed under `node_modules/` won't be picked up by that
glob. Options for that future:

- **Per-extension CSS bundle** — each extension produces its own
  `web-bundle.css` alongside `web-bundle.js`. Some duplication but
  isolated.
- **Post-install scan** — when an external extension is installed, the
  gateway re-runs Tailwind over the union of monorepo + node_modules
  extension sources to produce a single global stylesheet. Tailwind 4
  is fast enough that this is cheap.
- **Runtime CSS-in-JS for external extensions** — punt on Tailwind for
  externals and have them bring their own styling solution.

The right call probably depends on how external extensions end up looking
in practice. For now we have one global stylesheet built from monorepo
sources.

### Discovery and trust

External extensions need a registration model: how does the gateway find
them, what's the install lifecycle, how does the user audit them? That's
a design conversation for when the time comes — none of the bundler
infrastructure cares about how the extension's source files arrive on
disk, just where to look for `routes.ts`.

## Operational notes

- **No HMR.** `Bun.serve` is started with `development.hmr: false`. To
  pick up code changes, restart the gateway. Extension bundles
  rebuild automatically on the next request after a restart (in-memory
  cache is process-lifetime).
- **`Cache-Control: no-store`** on `/spa.js`, `/spa.css`, `/vendor/*`,
  `/extensions/*/web-bundle.js`. Browser cache won't mask code changes
  during dev. Long-cache headers stay on icons / static assets.
- **Build failures degrade gracefully.** A single extension bundle that
  fails to build returns 503 from `/extensions/<id>/web-bundle.js`; the
  SPA logs and skips that extension's contribution but keeps loading
  the others.
- **Vendor bundles built fire-and-forget at startup.** First request
  after a restart may 503 if it lands before the build finishes
  (typically <1s).

## Key files

| File                                            | Purpose                                                |
| ----------------------------------------------- | ------------------------------------------------------ |
| `packages/gateway/src/web/extension-bundler.ts` | Per-extension `Bun.build` + the exact-externals plugin |
| `packages/gateway/src/web/vendor-bundler.ts`    | Shared vendor bundles, runtime named-export discovery  |
| `packages/gateway/src/web/spa-bundler.ts`       | SPA shell build (Tailwind + same externals)            |
| `packages/gateway/src/web/index.tsx`            | SPA bootstrap — fetch + dynamic-import + render        |
| `packages/gateway/src/web/index.html`           | HTML shell + importmap                                 |
| `packages/ui/src/styles/index.css`              | Tailwind entry with `@source` globs                    |
| `packages/gateway/.web-vendor-entries/`         | Generated vendor entry stubs (gitignored)              |
