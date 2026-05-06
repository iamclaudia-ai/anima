import type {
  Message,
  TextBlock,
  ImageBlock,
  FileBlock,
  ToolUseBlock,
  ErrorBlock,
  ContentBlock,
} from "../types";
import { MessageContent } from "./MessageContent";
import { ToolCallBlock } from "./ToolCallBlock";
import { CopyButton } from "./CopyButton";
import CompactionBoundary from "./CompactionBoundary";
import { FileText, FileImage, File, OctagonX } from "lucide-react";
import { InlineExpansionProvider } from "./InlineExpansionProvider";
import { ToolTimeline } from "./tools/ToolTimeline";

function getFileIcon(mediaType: string) {
  if (mediaType.startsWith("image/")) return FileImage;
  if (mediaType.startsWith("text/") || mediaType === "application/pdf") return FileText;
  return File;
}

function getMessageRawContent(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === "text" || b.type === "thinking")
    .map((b) => b.content)
    .join("\n\n");
}

function formatTimestamp(ts?: number): string | null {
  if (!ts) return null;
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Strip invisible characters (zero-width spaces, BOM, etc.) and trim. */
function isBlankText(content: string | undefined): boolean {
  if (!content) return true;
  // Remove zero-width chars (U+200B..U+200D), word-joiner (U+2060), BOM (U+FEFF) —
  // String.prototype.trim doesn't classify these as whitespace.
  return content.replace(/[​-‍⁠﻿]/g, "").trim().length === 0;
}

/**
 * A "segment" is a slice of the message stream we render as one display row.
 * Assistant messages are sliced at non-tool block boundaries so consecutive
 * tool-like blocks across messages merge into a single timeline.
 */
type ToolEntry = {
  msgIdx: number;
  blockIdx: number;
  block: ContentBlock;
  /** Whether this entry is the very last block across all messages. */
  isLastInAllMessages: boolean;
};

type Segment =
  | { kind: "boundary"; msg: Message; msgIdx: number }
  | { kind: "user"; msg: Message; msgIdx: number }
  | { kind: "tool-row"; entries: ToolEntry[] }
  | {
      kind: "assistant-text";
      msg: Message;
      msgIdx: number;
      block: TextBlock & { originalIndex: number };
      isFirstTextInMsg: boolean;
    }
  | {
      kind: "assistant-error";
      msg: Message;
      msgIdx: number;
      block: ErrorBlock & { originalIndex: number };
    }
  | {
      kind: "assistant-unknown";
      msg: Message;
      msgIdx: number;
      block: ContentBlock & { originalIndex: number };
    }
  | { kind: "aborted"; msg: Message; msgIdx: number };

function buildSegments(messages: Message[]): Segment[] {
  const segments: Segment[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "compaction_boundary") {
      segments.push({ kind: "boundary", msg, msgIdx: i });
      continue;
    }

    if (msg.role === "user") {
      segments.push({ kind: "user", msg, msgIdx: i });
      continue;
    }

    // Assistant — slice blocks into tool / non-tool segments. Tool segments
    // merge with adjacent tool segments (including those from the previous
    // message) so back-to-back tool calls form a single timeline.
    let firstTextSeen = false;
    for (let j = 0; j < msg.blocks.length; j++) {
      const block = msg.blocks[j];
      const isLastInAllMessages = i === messages.length - 1 && j === msg.blocks.length - 1;
      const isToolLike =
        block.type === "thinking" ||
        block.type === "tool_use" ||
        (block.type === "text" && isBlankText(block.content));

      if (isToolLike) {
        const last = segments[segments.length - 1];
        const entry: ToolEntry = { msgIdx: i, blockIdx: j, block, isLastInAllMessages };
        if (last?.kind === "tool-row") last.entries.push(entry);
        else segments.push({ kind: "tool-row", entries: [entry] });
      } else if (block.type === "text") {
        const isFirst = !firstTextSeen;
        firstTextSeen = true;
        segments.push({
          kind: "assistant-text",
          msg,
          msgIdx: i,
          block: { ...block, originalIndex: j },
          isFirstTextInMsg: isFirst,
        });
      } else if (block.type === "error") {
        segments.push({
          kind: "assistant-error",
          msg,
          msgIdx: i,
          block: { ...block, originalIndex: j },
        });
      } else {
        segments.push({
          kind: "assistant-unknown",
          msg,
          msgIdx: i,
          block: { ...block, originalIndex: j } as ContentBlock & { originalIndex: number },
        });
      }
    }

    if (msg.aborted) {
      segments.push({ kind: "aborted", msg, msgIdx: i });
    }
  }

  return segments;
}

interface MessageListProps {
  messages: Message[];
  visibleCount: number;
  isQuerying: boolean;
  hasMore?: boolean;
  totalMessages?: number;
  onLoadEarlier(): void;
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  /** Callback for interactive tools (AskUserQuestion, ExitPlanMode) to send messages */
  onSendMessage?: (text: string) => void;
  /** Callback for interactive tools to send a tool_result */
  onSendToolResult?: (toolUseId: string, content: string, isError?: boolean) => void;
}

export function MessageList({
  messages,
  isQuerying,
  hasMore = false,
  totalMessages = 0,
  onLoadEarlier,
  messagesContainerRef,
  messagesEndRef,
  onSendMessage,
  onSendToolResult,
}: MessageListProps) {
  const remainingCount = totalMessages - messages.length;
  const segments = buildSegments(messages);
  const lastMsgIdx = messages.length - 1;

  return (
    <InlineExpansionProvider containerRef={messagesContainerRef}>
      <main
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-4"
      >
        {hasMore && (
          <button
            onClick={onLoadEarlier}
            className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Load {Math.min(50, remainingCount)} earlier messages
            {totalMessages > 0 && (
              <span className="ml-1 text-gray-400">
                ({messages.length} of {totalMessages})
              </span>
            )}
          </button>
        )}
        {segments.map((seg, idx) => {
          // ── Compaction boundary ──
          if (seg.kind === "boundary") {
            return (
              <CompactionBoundary
                key={`boundary-${idx}`}
                trigger={seg.msg.compaction?.trigger || "auto"}
                preTokens={seg.msg.compaction?.pre_tokens || 0}
                timestamp={seg.msg.timestamp}
              />
            );
          }

          // ── User message ──
          if (seg.kind === "user") {
            return (
              <div key={`user-${seg.msgIdx}`} className="ml-12">
                <UserHeader msg={seg.msg} />
                <UserMessage msg={seg.msg} />
              </div>
            );
          }

          // ── Tool timeline (may span multiple messages) ──
          if (seg.kind === "tool-row") {
            const isLatestRow = seg.entries.some((e) => e.msgIdx === lastMsgIdx);
            return (
              <div key={`toolrow-${idx}`} className="mr-12">
                <ToolTimeline>
                  {seg.entries.map((entry) => {
                    const { block, isLastInAllMessages, msgIdx, blockIdx } = entry;
                    if (block.type === "thinking") {
                      return (
                        <MessageContent
                          key={`${msgIdx}-${blockIdx}`}
                          content={(block as TextBlock).content}
                          type="thinking"
                          isLoading={isLastInAllMessages && isQuerying}
                        />
                      );
                    }
                    if (block.type === "tool_use") {
                      const tool = block as ToolUseBlock;
                      const isInteractiveTool =
                        tool.name === "ExitPlanMode" || tool.name === "EnterPlanMode";
                      return (
                        <ToolCallBlock
                          key={tool.id}
                          name={tool.name}
                          input={tool.input}
                          result={tool.result}
                          isLoading={!tool.result && isQuerying}
                          toolUseId={tool.id}
                          onSendMessage={
                            isLatestRow || isInteractiveTool ? onSendMessage : undefined
                          }
                          onSendToolResult={
                            isLatestRow || isInteractiveTool ? onSendToolResult : undefined
                          }
                        />
                      );
                    }
                    // Empty text block — no-op
                    return null;
                  })}
                </ToolTimeline>
              </div>
            );
          }

          // ── Assistant text paragraph ──
          if (seg.kind === "assistant-text") {
            return (
              <div key={`atext-${seg.msgIdx}-${seg.block.originalIndex}`} className="mr-12">
                {seg.isFirstTextInMsg && <AssistantHeader msg={seg.msg} />}
                <MessageContent content={seg.block.content} type="assistant" />
              </div>
            );
          }

          // ── Assistant error block ──
          if (seg.kind === "assistant-error") {
            const err = seg.block;
            if (err.isRetrying) {
              return (
                <div
                  key={`aerr-${seg.msgIdx}-${err.originalIndex}`}
                  className="mr-12 mt-2 px-3 py-2 text-sm bg-amber-50 border border-amber-200 rounded-md flex items-center gap-2"
                >
                  <svg
                    className="w-4 h-4 text-amber-500 animate-spin shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  <span className="text-amber-700">{err.message}</span>
                  {err.retryInMs && (
                    <span className="text-amber-500 text-xs ml-auto">
                      retrying in {(err.retryInMs / 1000).toFixed(0)}s
                    </span>
                  )}
                </div>
              );
            }
            return (
              <div
                key={`aerr-${seg.msgIdx}-${err.originalIndex}`}
                className="mr-12 mt-2 px-3 py-2 text-sm bg-red-50 border border-red-200 rounded-md"
              >
                <div className="flex items-center gap-2">
                  <svg
                    className="w-4 h-4 text-red-500 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                    />
                  </svg>
                  <span className="text-red-700 font-medium">{err.message}</span>
                  {err.status && (
                    <span className="text-red-400 text-xs ml-auto">HTTP {err.status}</span>
                  )}
                </div>
              </div>
            );
          }

          // ── Aborted indicator ──
          if (seg.kind === "aborted") {
            return (
              <div
                key={`aborted-${seg.msgIdx}`}
                className="mr-12 mt-3 flex items-center gap-2 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md w-fit"
              >
                <OctagonX className="w-4 h-4 flex-shrink-0" />
                <span>Interrupted · What should Claudia do instead?</span>
              </div>
            );
          }

          // ── Unknown block fallback ──
          return (
            <div
              key={`unknown-${idx}`}
              className="mr-12 mt-2 p-3 bg-yellow-50 border border-yellow-200 rounded-md"
            >
              <div className="text-sm font-mono text-yellow-800">
                <strong>Unknown message type:</strong>{" "}
                {(seg.block as { type?: string }).type || "undefined"}
              </div>
              <pre className="text-xs text-yellow-700 mt-1 whitespace-pre-wrap">
                {JSON.stringify(seg.block, null, 2)}
              </pre>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </main>
    </InlineExpansionProvider>
  );
}

// ── Sub-components ──────────────────────────────────────────

function UserHeader({ msg }: { msg: Message }) {
  const hasText = msg.blocks.some((b) => b.type === "text" && b.content?.trim());
  if (!hasText) return null;
  const rawContent = getMessageRawContent(msg.blocks);
  const time = formatTimestamp(msg.timestamp);
  return (
    <div className="flex items-center gap-2 mb-1 justify-end">
      {time && <span className="text-xs text-gray-400">{time}</span>}
      <CopyButton text={rawContent} />
    </div>
  );
}

function AssistantHeader({ msg }: { msg: Message }) {
  const rawContent = getMessageRawContent(msg.blocks);
  const time = formatTimestamp(msg.timestamp);
  if (!rawContent.trim()) return null;
  return (
    <div className="flex items-center gap-2 mb-1">
      <CopyButton text={rawContent} />
      {time && <span className="text-xs text-gray-400">{time}</span>}
    </div>
  );
}

function UserMessage({ msg }: { msg: Message }) {
  return (
    <div className="space-y-2">
      {msg.blocks.filter((b) => b.type === "image").length > 0 && (
        <div className="flex flex-wrap gap-2 justify-end">
          {msg.blocks
            .filter((b): b is ImageBlock => b.type === "image")
            .map((img, idx) => (
              <img
                key={idx}
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={`Attachment ${idx + 1}`}
                className="max-h-48 max-w-xs rounded-md border border-gray-300"
              />
            ))}
        </div>
      )}
      {msg.blocks.filter((b) => b.type === "file").length > 0 && (
        <div className="flex flex-wrap gap-2 justify-end">
          {msg.blocks
            .filter((b): b is FileBlock => b.type === "file")
            .map((file, idx) => {
              const FileIcon = getFileIcon(file.mediaType);
              return (
                <div
                  key={idx}
                  className="flex items-center gap-2 px-3 py-2 rounded-md border border-gray-300 bg-gray-50"
                >
                  <FileIcon className="w-5 h-5 text-gray-500" />
                  <span className="text-sm text-gray-700">{file.filename || "file"}</span>
                </div>
              );
            })}
        </div>
      )}
      {msg.blocks
        .filter((b): b is TextBlock => b.type === "text")
        .map((block, idx) => (
          <MessageContent key={idx} content={block.content} type="user" />
        ))}
    </div>
  );
}
