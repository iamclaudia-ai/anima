/**
 * Unit tests for flattenLayout — translates declarative LayoutNode trees into
 * the imperative panel-add sequence dockview consumes.
 *
 * The walk has to be exactly right: each subsequent panel must reference an
 * already-added one with the correct direction. These tests lock down the
 * traversal order, reference-passing, and instance-ID generation.
 */

import { describe, expect, it } from "bun:test";
import type { LayoutNode } from "@anima/shared";
import { flattenLayout, layoutFingerprint } from "./layout-flatten";

describe("flattenLayout", () => {
  it("emits a single request for a leaf-only layout", () => {
    const layout: LayoutNode = { panel: "chat.main" };
    const result = flattenLayout(layout);
    expect(result).toEqual([
      {
        id: "chat.main",
        panelId: "chat.main",
        title: "chat.main",
        referencePanel: undefined,
        direction: undefined,
        params: undefined,
        size: undefined,
      },
    ]);
  });

  it("walks a horizontal split left → right", () => {
    const layout: LayoutNode = {
      direction: "horizontal",
      children: [{ panel: "nav" }, { panel: "main" }, { panel: "side" }],
    };
    const result = flattenLayout(layout);
    expect(result.map((r) => ({ id: r.id, ref: r.referencePanel, dir: r.direction }))).toEqual([
      { id: "nav", ref: undefined, dir: undefined },
      { id: "main", ref: "nav", dir: "right" },
      { id: "side", ref: "main", dir: "right" },
    ]);
  });

  it("walks a vertical split top → bottom", () => {
    const layout: LayoutNode = {
      direction: "vertical",
      children: [{ panel: "chat" }, { panel: "term" }],
    };
    const result = flattenLayout(layout);
    expect(result.map((r) => ({ id: r.id, ref: r.referencePanel, dir: r.direction }))).toEqual([
      { id: "chat", ref: undefined, dir: undefined },
      { id: "term", ref: "chat", dir: "below" },
    ]);
  });

  it("handles nested splits — horizontal of [leaf, vertical[a,b]]", () => {
    const layout: LayoutNode = {
      direction: "horizontal",
      children: [
        { panel: "nav" },
        {
          direction: "vertical",
          children: [{ panel: "chat" }, { panel: "term" }],
        },
      ],
    };
    const result = flattenLayout(layout);
    expect(result.map((r) => ({ id: r.id, ref: r.referencePanel, dir: r.direction }))).toEqual([
      { id: "nav", ref: undefined, dir: undefined },
      // First leaf of the vertical split sits to the right of the previous sibling (nav).
      { id: "chat", ref: "nav", dir: "right" },
      // Second leaf of the vertical split sits below its sibling (chat).
      { id: "term", ref: "chat", dir: "below" },
    ]);
  });

  it("handles the IDE-style three-column layout", () => {
    const layout: LayoutNode = {
      direction: "horizontal",
      children: [
        { panel: "nav.tree" },
        {
          direction: "vertical",
          children: [{ panel: "chat.main" }, { panel: "term.shell" }],
        },
        {
          direction: "vertical",
          children: [{ panel: "git.review" }, { panel: "files.tree" }],
        },
      ],
    };
    const result = flattenLayout(layout);
    expect(result.map((r) => ({ id: r.id, ref: r.referencePanel, dir: r.direction }))).toEqual([
      { id: "nav.tree", ref: undefined, dir: undefined },
      { id: "chat.main", ref: "nav.tree", dir: "right" },
      { id: "term.shell", ref: "chat.main", dir: "below" },
      // Right column — first leaf attaches to the previous sibling's first leaf.
      { id: "git.review", ref: "chat.main", dir: "right" },
      { id: "files.tree", ref: "git.review", dir: "below" },
    ]);
  });

  it("generates unique instance IDs for repeated panels", () => {
    const layout: LayoutNode = {
      direction: "horizontal",
      children: [{ panel: "term" }, { panel: "term" }, { panel: "term" }],
    };
    const result = flattenLayout(layout);
    expect(result.map((r) => r.id)).toEqual(["term", "term#1", "term#2"]);
    // Ensure the references chain correctly using those instance IDs.
    expect(result.map((r) => r.referencePanel)).toEqual([undefined, "term", "term#1"]);
  });

  it("respects an explicit instanceId on a leaf", () => {
    const layout: LayoutNode = {
      direction: "horizontal",
      children: [
        { panel: "term", instanceId: "term.left" },
        { panel: "term", instanceId: "term.right" },
      ],
    };
    const result = flattenLayout(layout);
    expect(result.map((r) => r.id)).toEqual(["term.left", "term.right"]);
    expect(result[1]?.referencePanel).toBe("term.left");
  });

  it("forwards per-leaf params and size", () => {
    const layout: LayoutNode = {
      direction: "horizontal",
      children: [
        { panel: "chat", params: { sessionId: "abc" }, size: 600 },
        { panel: "side", size: 240 },
      ],
    };
    const result = flattenLayout(layout);
    expect(result[0]?.params).toEqual({ sessionId: "abc" });
    expect(result[0]?.size).toBe(600);
    expect(result[1]?.size).toBe(240);
  });
});

describe("layoutFingerprint", () => {
  it("returns the panel id for a leaf", () => {
    expect(layoutFingerprint({ panel: "chat.main" })).toBe("chat.main");
  });

  it("includes instanceId when present", () => {
    expect(layoutFingerprint({ panel: "term", instanceId: "left" })).toBe("term#left");
  });

  it("encodes split direction and child structure", () => {
    const fp = layoutFingerprint({
      direction: "horizontal",
      children: [
        { panel: "a" },
        { direction: "vertical", children: [{ panel: "b" }, { panel: "c" }] },
      ],
    });
    expect(fp).toBe("horizontal[a,vertical[b,c]]");
  });

  it("changes when a panel is added", () => {
    const before = layoutFingerprint({
      direction: "horizontal",
      children: [{ panel: "a" }, { panel: "b" }],
    });
    const after = layoutFingerprint({
      direction: "horizontal",
      children: [{ panel: "a" }, { panel: "b" }, { panel: "c" }],
    });
    expect(before).not.toBe(after);
  });

  it("changes when direction is flipped", () => {
    const before = layoutFingerprint({
      direction: "horizontal",
      children: [{ panel: "a" }, { panel: "b" }],
    });
    const after = layoutFingerprint({
      direction: "vertical",
      children: [{ panel: "a" }, { panel: "b" }],
    });
    expect(before).not.toBe(after);
  });
});
