import { describe, expect, test } from "bun:test";
import { toRuntimeStatusFromModalEvent, toRuntimeStatusFromSessionEvent } from "./session-types";

/**
 * The mapper is the single funnel from agent-host events to `runtime_status`,
 * and modal prompts (#69) are the only writer of the two attention states —
 * so these cases are the whole reason `awaiting_approval` and `awaiting_input`
 * exist in the schema.
 */
describe("toRuntimeStatusFromSessionEvent", () => {
  test("maps process lifecycle", () => {
    expect(toRuntimeStatusFromSessionEvent("process_started")).toBe("running");
    expect(toRuntimeStatusFromSessionEvent("process_ended")).toBe("idle");
  });

  test("an approval modal is awaiting_approval", () => {
    expect(toRuntimeStatusFromModalEvent("modal_prompt", { kind: "approval" })).toBe(
      "awaiting_approval",
    );
  });

  test("any other modal is awaiting_input", () => {
    expect(toRuntimeStatusFromModalEvent("modal_prompt", { kind: "input" })).toBe("awaiting_input");
    // Missing kind falls to input rather than claiming something was approved.
    expect(toRuntimeStatusFromModalEvent("modal_prompt", {})).toBe("awaiting_input");
  });

  test("a cleared modal returns to whatever was waiting behind it", () => {
    expect(toRuntimeStatusFromModalEvent("modal_prompt_cleared", { resumedTurn: true })).toBe(
      "running",
    );
    expect(toRuntimeStatusFromModalEvent("modal_prompt_cleared", { resumedTurn: false })).toBe(
      "idle",
    );
  });

  test("turn_stop is deliberately unmapped — its own handler writes completed", () => {
    expect(toRuntimeStatusFromSessionEvent("turn_stop")).toBeNull();
  });

  test("streamed events don't move status", () => {
    expect(toRuntimeStatusFromSessionEvent("content_block_delta")).toBeNull();
  });
});
