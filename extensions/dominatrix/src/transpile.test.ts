import { describe, expect, test } from "bun:test";
import { Interpreter, parse } from "@mariozechner/jailjs";
import { transpileForJail } from "./transpile";

/**
 * A faithful NodeList stand-in: indexed properties, `length`, and
 * `Symbol.iterator`, but NOT an Array. Testing against a real array hides the
 * exact bug this module exists to avoid.
 */
function nodeList(items: string[]): Record<string | symbol, unknown> {
  const nl: Record<string | symbol, unknown> = { length: items.length };
  items.forEach((v, i) => (nl[i] = v));
  nl[Symbol.iterator] = function* () {
    for (const item of items) yield item;
  };
  return nl;
}

/** Run source through the transpiler and the interpreter it targets. */
function runInJail(source: string, items = ["a", "b", "c"]): unknown {
  const es5 = transpileForJail(source);
  expect(es5).not.toBeNull();
  const globals = {
    document: { querySelectorAll: () => nodeList(items) },
    window: {},
    console,
    JSON,
    Math,
    Date,
  };
  return new Interpreter(globals as never, { maxOps: 1_000_000 }).evaluate(parse(es5!));
}

describe("transpileForJail", () => {
  test("spreads a NodeList by value, not into a single wrapped element", () => {
    // Regression guard: jailjs's own transformToES5 compiles this to
    // `[].concat(nodeList)` and silently returns 1.
    expect(runInJail("[...document.querySelectorAll('*')].length")).toBe(3);
  });

  test("supports methods on a spread NodeList", () => {
    expect(
      runInJail("[...document.querySelectorAll('*')].map(function(x){return x+'!';}).join(',')"),
    ).toBe("a!,b!,c!");
  });

  test("handles the arrow + const + spread expression shape callers actually write", () => {
    expect(
      runInJail(
        "(() => { const els = [...document.querySelectorAll('*')]; return els.length; })()",
      ),
    ).toBe(3);
  });

  test("still spreads real arrays correctly", () => {
    expect(runInJail("(function(){ var a = [1,2]; return [...a, 3].length; })()")).toBe(3);
  });

  test.each([
    ["template literal", "(function(){ var n = 5; return `n=${n}`; })()", "n=5"],
    ["destructuring", "(function(){ var [a,b] = [1,2]; return a+b; })()", 3],
    ["class", "(function(){ class A { m(){ return 7; } } return new A().m(); })()", 7],
    ["optional chaining", "(function(){ var o = {}; return o?.x?.y === undefined; })()", true],
    ["default param", "(function(){ return (function(y = 5){ return y; })(); })()", 5],
    ["rest param", "(function(){ return (function(...r){ return r.length; })(1,2,3); })()", 3],
    [
      "for..of over array",
      "(function(){ var t=0; for (const x of [1,2,3]) t+=x; return t; })()",
      6,
    ],
  ])("compiles %s", (_label, source, expected) => {
    expect(runInJail(source)).toEqual(expected);
  });

  test("passes plain ES5 through unharmed", () => {
    expect(runInJail("1 + 1")).toBe(2);
  });

  test("returns null on a syntax error so the caller can fall back", () => {
    expect(transpileForJail("this is ( not javascript")).toBeNull();
  });
});
