/**
 * Model-id helpers shared across the session lifecycle.
 *
 * Claude models can carry a trailing context-window variant suffix, e.g.
 * `claude-opus-4-7[1m]` for the 1M-token window. That suffix selects a context
 * size, not a different model — so for drift detection (deciding whether the
 * running runtime must be recycled because the user switched models) it must be
 * ignored. Otherwise `claude-opus-4-7[1m]` (requested) vs `claude-opus-4-7`
 * (what the CLI runtime reports for getInfo) reads as a constant mismatch and
 * recycles the session on every prompt.
 */

/** Strip the trailing `[...]` context-variant suffix from a model id. */
export function baseModelId(model: string): string {
  return model.replace(/\[[^\]]*\]\s*$/, "").trim();
}

/** True when two model ids name the same model, ignoring context variant. */
export function sameModel(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return baseModelId(a) === baseModelId(b);
}
