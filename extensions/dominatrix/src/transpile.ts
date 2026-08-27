import * as Babel from "@babel/standalone";

/**
 * Transpile modern JavaScript down to ES5 for the browser-side JailJS
 * interpreter.
 *
 * `eval` / `exec` run in the page through JailJS, an AST interpreter, because
 * pages with a strict CSP forbid real `eval`. JailJS only implements a subset
 * of the language — no template literals, array spread, destructuring,
 * `for..of`, `class`, optional chaining, or default/rest params (those last
 * ones fail *silently*: the parameter simply never binds). Transpiling here
 * means callers write normal modern JS and the interpreter only ever sees the
 * subset it handles.
 *
 * This runs in the extension, not the page: `@babel/standalone` is ~5.6 MB,
 * which is fine in Bun and would be intolerable in a content script injected
 * into every tab.
 *
 * We deliberately do NOT use jailjs's own `transformToES5`. It sets
 * `assumptions.iterableIsArray`, so spread compiles to `[].concat(x)` — right
 * for a real array, but for a NodeList that *wraps* instead of spreading, so
 * `[...document.querySelectorAll("a")]` silently yields one element instead of
 * N. Since spreading a DOM collection is the single most common thing anyone
 * does here, we use `arrayLikeIsIterable` instead, which compiles to a helper
 * that reads array-likes correctly.
 */
const PRESETS = [
  ["env", { targets: { ie: 9 }, useBuiltIns: false, forceAllTransforms: true }],
] as const;

const ASSUMPTIONS = {
  noDocumentAll: true,
  noClassCalls: true,
  constantSuper: true,
  setPublicClassFields: true,
  privateFieldsAsProperties: true,
  objectRestNoSymbols: true,
  setSpreadProperties: true,
  skipForOfIteratorClosing: true,
  // NodeList / HTMLCollection: spread and iterate array-likes by index rather
  // than assuming they are already arrays. This is the fix described above.
  arrayLikeIsIterable: true,
} as const;

/**
 * JailJS evaluates the receiver of a method call **twice** — `get().m()` runs
 * `get()` twice, while plain property access runs it once. Babel's `for..of`
 * helper relies on the receiver being evaluated once:
 *
 *     if (t) return (t = t.call(r)).next.bind(t);
 *
 * On the second evaluation `t` is no longer the iterator function but the
 * iterator object, so `t.call` is undefined and the loop dies with "Value is
 * not a function". Splitting the assignment out of the receiver position makes
 * the double evaluation harmless.
 *
 * This patches only the helper we emit. It does NOT fix the underlying
 * interpreter bug, which still affects caller code with a side-effecting
 * receiver (`getThing().method()`) — that is documented in the skill and
 * reported upstream.
 */
const FOR_OF_RECEIVER_BUG = "if (t) return (t = t.call(r)).next.bind(t);";
const FOR_OF_RECEIVER_FIX = "if (t) { t = t.call(r); return t.next.bind(t); }";

/** Exported for the canary test that catches Babel changing this helper. */
export const forOfHelperPatch = {
  broken: FOR_OF_RECEIVER_BUG,
  fixed: FOR_OF_RECEIVER_FIX,
} as const;

/**
 * Returns ES5 source, or `null` if the input cannot be transpiled (a syntax
 * error, say). Callers pass the original source through on `null` so the page's
 * own `eval` fallback still gets a chance on non-CSP sites.
 */
export function transpileForJail(source: string): string | null {
  try {
    const result = Babel.transform(source, {
      presets: PRESETS as never,
      assumptions: ASSUMPTIONS,
      filename: "dominatrix-eval.js",
      code: true,
      ast: false,
      // Expressions are evaluated for their value; "use strict" and module
      // wrapping would both get in the way.
      sourceType: "script",
      comments: false,
    });
    const code = result?.code;
    if (!code) return null;
    return code.replace(FOR_OF_RECEIVER_BUG, FOR_OF_RECEIVER_FIX);
  } catch {
    return null;
  }
}
