import { ArrowUp, X } from "lucide-react";

interface SendStopButtonProps {
  /** True while a model query is in flight. */
  isQuerying: boolean;
  /** True if there's user-typed content or attachments queued. */
  hasContent: boolean;
  /** True when the gateway connection is up. */
  isConnected: boolean;
  onSend(): void;
  onInterrupt(): void;
}

/**
 * The floating action button anchored inside the textarea. Shows the send
 * (blue arrow) variant when there's something to send OR the model is idle;
 * shows the stop (red X) variant only when a query is running AND the input
 * is empty (so the user can keep typing the next prompt without losing the
 * Send affordance).
 */
export function SendStopButton({
  isQuerying,
  hasContent,
  isConnected,
  onSend,
  onInterrupt,
}: SendStopButtonProps) {
  const showSend = hasContent || !isQuerying;
  return (
    <button
      onClick={showSend ? onSend : onInterrupt}
      disabled={showSend && (!isConnected || !hasContent)}
      className={`absolute bottom-4 right-2 size-8 rounded-full flex items-center justify-center transition-colors ${
        showSend
          ? "bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
          : "bg-red-500 hover:bg-red-600"
      } text-white`}
      aria-label={showSend ? "Send message" : "Stop"}
    >
      {showSend ? <ArrowUp className="size-4" /> : <X className="size-4" />}
    </button>
  );
}
