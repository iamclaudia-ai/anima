/**
 * "Claude is waiting on you, and until now had no way to say so."
 *
 * The CLI runs in a tmux pane. When a hook returns `permissionDecision: "ask"`
 * — dcg's `warn` tier is the usual culprit — the TUI stops on a full-screen
 * modal and waits for a keypress. There is no SSE for that, no JSONL entry,
 * nothing on the proxy: from out here the session simply stops producing
 * output, which is indistinguishable from a long tool call. The only way to
 * find out used to be `tmux attach`.
 *
 * Rendered where the tool call would be, not as a banner, because answering it
 * is a judgement call and the judgement needs the context: which command, which
 * rule, and what the hook said about it.
 *
 * Two states this has to get right:
 *
 * - **Answered elsewhere.** The pane is still a real terminal Michael can
 *   attach to, so a prompt can be answered without us. The runtime notices the
 *   modal left the screen and the block settles as "answered in the terminal" —
 *   never as a live prompt with dead buttons.
 * - **Settled prompts stay settled.** This block sits in the message stream, so
 *   it is still on screen an hour later. Once answered it stops offering
 *   choices and states what happened.
 */

import { Check, CircleAlert, ShieldQuestion, Terminal } from "lucide-react";
import type { ModalPromptBlock as ModalPromptBlockType } from "../types";

interface ModalPromptBlockProps {
  block: ModalPromptBlockType;
  onAnswer: (fingerprint: string, key: string) => void;
}

/**
 * Body lines minus the question, which is already the headline. The TUI hard-
 * wraps its text, so a wrapped continuation line is joined back rather than
 * rendered as its own paragraph.
 */
function bodyLines(block: ModalPromptBlockType): string[] {
  return block.context.filter((line) => line && line !== block.question);
}

export function ModalPromptBlock({ block, onAnswer }: ModalPromptBlockProps): React.ReactElement {
  const settled = Boolean(block.answered) || Boolean(block.dismissed);
  const chosen = block.options.find((opt) => opt.key === block.answered);
  const body = bodyLines(block);

  return (
    <div
      className={`md:mr-12 mt-2 rounded-md border text-sm ${
        settled ? "border-slate-200 bg-slate-50" : "border-amber-300 bg-amber-50"
      }`}
    >
      <div
        className={`flex items-center gap-2 px-3 py-2 ${
          settled ? "text-slate-600" : "text-amber-900"
        }`}
      >
        {settled ? (
          <Check className="size-4 shrink-0 text-slate-400" />
        ) : (
          <ShieldQuestion className="size-4 shrink-0 text-amber-500" />
        )}
        <span className="font-medium">
          {settled
            ? block.answered
              ? `Answered — ${chosen?.label ?? block.answered}`
              : "Answered in the terminal"
            : block.kind === "approval"
              ? "Claude needs your approval"
              : "Claude is waiting for an answer"}
        </span>
      </div>

      <div className={`px-3 pb-2 ${settled ? "text-slate-500" : "text-amber-900"}`}>
        <p className="font-medium">{block.question}</p>
        {body.length > 0 && (
          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded bg-white/60 px-2 py-1.5 font-mono text-xs text-slate-600">
            {body.join("\n")}
          </pre>
        )}
      </div>

      {!settled && (
        <div className="flex flex-wrap items-center gap-2 border-t border-amber-200 px-3 py-2">
          {block.options.map((opt, i) => (
            <button
              key={opt.key}
              type="button"
              disabled={block.pending}
              onClick={() => onAnswer(block.fingerprint, opt.key)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                // First option is the affirmative one in every modal the CLI
                // renders — it's the one under `❯` when the prompt appears.
                i === 0
                  ? "bg-amber-600 text-white hover:bg-amber-700"
                  : "border border-amber-300 text-amber-800 hover:bg-amber-200/60"
              }`}
            >
              {opt.label}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-1 text-xs text-amber-700/70">
            <Terminal className="size-3" />
            or answer it in the pane
          </span>
        </div>
      )}

      {block.error && (
        <div className="flex items-start gap-1.5 border-t border-amber-200 px-3 py-2 text-xs text-red-700">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          <span>{block.error}</span>
        </div>
      )}
    </div>
  );
}
