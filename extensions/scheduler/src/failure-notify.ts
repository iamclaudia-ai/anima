/**
 * Tell Michael when a scheduled task breaks, and when it recovers.
 *
 * A failure that only lands in the execution history is invisible: Wings
 * failed every morning for weeks on Anima Sedes before anyone looked. So a
 * finished run is compared with the task's previous finished run, and only
 * the transitions are news:
 *
 *   success (or first run) → error   "failed"
 *   error                  → success "recovered"
 *
 * Not every failure: the lights task runs every five minutes, and a broken one
 * would otherwise text him all night.
 */

import type { ExtensionContext } from "@anima/shared";

export type RunOutcome = "success" | "error";
export type Transition = "failed" | "recovered";

/** Statuses that count as a finished run (not running, not skipped). */
const FINISHED = new Set<string>(["success", "error"]);

export function transitionFor(
  previous: string | undefined,
  current: RunOutcome,
): Transition | null {
  const before = previous && FINISHED.has(previous) ? previous : undefined;
  if (current === "error" && before !== "error") return "failed";
  if (current === "success" && before === "error") return "recovered";
  return null;
}

/** The previous finished run's status, skipping the run that just ended. */
export function previousOutcome(
  executions: Array<{ id: string; status: string }>,
  currentExecId: string,
): string | undefined {
  return executions.find((e) => e.id !== currentExecId && FINISHED.has(e.status))?.status;
}

/** First line of an error, trimmed to what fits in a text message. */
function headline(error: string): string {
  const line =
    error
      .replace(/^Error:\s*/, "")
      .split("\n")[0]
      ?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

export async function notifyTransition(
  ctx: ExtensionContext,
  task: { id: string; name: string },
  transition: Transition,
  error?: string,
): Promise<void> {
  const message =
    transition === "failed"
      ? `Scheduled task "${task.name}" failed${error ? `: ${headline(error)}` : "."}\nanima scheduler get_history --taskId ${task.id}`
      : `Scheduled task "${task.name}" is working again.`;
  try {
    await ctx.call("notify.send", {
      title: transition === "failed" ? "Task failed" : "Task recovered",
      message,
      source: "scheduler",
    });
  } catch (err) {
    // Best effort: a host without the notify extension still runs its tasks.
    ctx.log.warn("Could not send task notification", {
      task: task.name,
      transition,
      error: String(err),
    });
  }
}
