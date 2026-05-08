/**
 * Sanity tests for Zod → JSON Schema export.
 *
 * Background: when Zod was bumped from v3 → v4, our previous serializer
 * `zod-to-json-schema@3` silently produced empty `{}` definitions for every
 * extension method. The CLI's `--help` and validation went mute, and a stray
 * `anima scheduler get_history` (no args) trickled through to the handler as
 * `taskId: undefined` instead of being rejected at the boundary.
 *
 * These tests assert the *shape* we depend on:
 *   1. `properties` is populated for non-empty schemas
 *   2. `required` reflects which fields lack defaults / `.optional()`
 *   3. Default values flow through (so help text can show them)
 *
 * If a future refactor swaps the converter and these regress, the CI catches
 * it before the user finds it via a stuck `--watch` loop.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";

describe("z.toJSONSchema (Zod v4 built-in)", () => {
  it("produces non-empty properties for a typical method schema", () => {
    const schema = z.object({
      taskId: z.string(),
      limit: z.number().default(50),
    });

    const json = z.toJSONSchema(schema, { io: "input" }) as {
      type?: string;
      properties?: Record<string, { type?: string; default?: unknown }>;
      required?: string[];
    };

    expect(json.type).toBe("object");
    expect(json.properties).toBeDefined();
    expect(Object.keys(json.properties ?? {})).toEqual(["taskId", "limit"]);
    expect(json.properties?.taskId?.type).toBe("string");
    expect(json.properties?.limit?.type).toBe("number");
    expect(json.properties?.limit?.default).toBe(50);
  });

  it("marks .optional() fields as not required", () => {
    const schema = z.object({
      required: z.string(),
      maybe: z.string().optional(),
    });

    const json = z.toJSONSchema(schema, { io: "input" }) as { required?: string[] };

    expect(json.required).toContain("required");
    expect(json.required ?? []).not.toContain("maybe");
  });

  it("input mode treats .default() fields as not required (CLI UX contract)", () => {
    // Regression guard: the CLI's `--help` and validation read `required[]` to
    // decide which params the user MUST supply. With the default `output`
    // mode, a `.default(50)` field is required (guaranteed present after
    // parsing), which would force users to redundantly pass values the schema
    // already provides. Input mode is the right semantic for our boundary.
    const schema = z.object({
      mandatory: z.string(),
      withDefault: z.number().default(50),
    });

    const inputJson = z.toJSONSchema(schema, { io: "input" }) as { required?: string[] };
    expect(inputJson.required).toEqual(["mandatory"]);

    const outputJson = z.toJSONSchema(schema) as { required?: string[] };
    expect(outputJson.required).toContain("withDefault");
  });

  it("preserves enum constraints", () => {
    const schema = z.object({
      mode: z.enum(["read", "write"]),
    });

    const json = z.toJSONSchema(schema) as {
      properties?: { mode?: { enum?: string[] } };
    };

    expect(json.properties?.mode?.enum).toEqual(["read", "write"]);
  });
});
