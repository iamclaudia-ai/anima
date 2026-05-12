import { useCallback, useRef } from "react";
import type { Attachment, Usage } from "../types";
import { useBridge } from "../bridge";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { useCommands } from "../hooks/useCommands";
import { useFiles } from "../hooks/useFiles";
import { useContainerWidth } from "../hooks/useContainerWidth";
import { useFileAttachments } from "../hooks/useFileAttachments";
import { useFocusRestore } from "../hooks/useFocusRestore";
import { useInputPickers } from "../hooks/useInputPickers";
import { useTextareaAutosize } from "../hooks/useTextareaAutosize";
import { useTypingState } from "../hooks/useTypingState";
import { AttachmentsList } from "./AttachmentsList";
import { Bogart } from "./Bogart";
import { CommandPicker } from "./CommandPicker";
import { ContextRing } from "./ContextRing";
import { FilePicker } from "./FilePicker";
import { GitStatusBar } from "./GitStatusBar";
import { SendStopButton } from "./SendStopButton";
import type { GitStatusInfo } from "../hooks/useChatGateway";

interface InputAreaProps {
  input: string;
  onInputChange(value: string): void;
  attachments: Attachment[];
  onAttachmentsChange(attachments: Attachment[]): void;
  isConnected: boolean;
  isQuerying: boolean;
  usage: Usage | null;
  onSend(): void;
  onInterrupt(): void;
  gitStatus?: GitStatusInfo | null;
}

const IS_TAURI = typeof window !== "undefined" && "__TAURI__" in window;

export function InputArea({
  input,
  onInputChange,
  attachments,
  onAttachmentsChange,
  isConnected,
  isQuerying,
  usage,
  onSend,
  onInterrupt,
  gitStatus,
}: InputAreaProps) {
  const bridge = useBridge();
  const workspace = useWorkspace();
  const { items: commandItems } = useCommands(workspace.cwd);
  const { files } = useFiles(workspace.cwd);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaContainerRef = useRef<HTMLDivElement>(null);

  // ── Container width, autosize, typing/focus state ───────────────────────
  const containerWidth = useContainerWidth(textareaContainerRef);
  useTextareaAutosize(textareaRef, input);
  const { isTyping, ping: pingTyping } = useTypingState();

  // ── Pickers (slash + file `@`) ──────────────────────────────────────────
  const pickers = useInputPickers({
    input,
    onInputChange,
    saveDraft: bridge.saveDraft,
    commandItems,
    files,
    textareaRef,
  });

  // Focus restore needs the same cursor ref the pickers use.
  useFocusRestore(textareaRef, pickers.cursorPositionRef, isConnected);

  // ── Attachments (paste / drop / remove) ─────────────────────────────────
  const { isDragging, handlePaste, handleDragOver, handleDragLeave, handleDrop, removeAttachment } =
    useFileAttachments({ attachments, onAttachmentsChange });

  // ── Input event wiring ──────────────────────────────────────────────────
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      onInputChange(value);
      bridge.saveDraft(value);
      pingTyping();
      pickers.notifyInputChange(value, {
        start: e.target.selectionStart,
        end: e.target.selectionEnd,
      });
    },
    [onInputChange, bridge, pingTyping, pickers],
  );

  const handleBlur = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    pickers.cursorPositionRef.current = {
      start: el.selectionStart,
      end: el.selectionEnd,
    };
  }, [pickers]);

  // ── Keyboard handler — pickers first, then Tauri Cmd shortcuts, then
  //    the global Cmd+Enter / Escape bindings. ─────────────────────────────
  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (pickers.handlePickerKeyDown(e)) return;

      // Tauri/macOS fallback: ensure common Cmd shortcuts work in the prompt.
      if (IS_TAURI && e.metaKey && !e.ctrlKey && !e.altKey) {
        const key = e.key.toLowerCase();
        const el = textareaRef.current;
        if (el) {
          if (key === "a") {
            e.preventDefault();
            el.select();
            return;
          }
          if (key === "c") {
            if (el.selectionStart !== el.selectionEnd) {
              e.preventDefault();
              const selected = input.slice(el.selectionStart, el.selectionEnd);
              try {
                await navigator.clipboard.writeText(selected);
              } catch {
                // Leave as no-op if clipboard API isn't available.
              }
            }
            return;
          }
          if (key === "x") {
            if (el.selectionStart !== el.selectionEnd) {
              e.preventDefault();
              const start = el.selectionStart;
              const end = el.selectionEnd;
              const selected = input.slice(start, end);
              const nextValue = input.slice(0, start) + input.slice(end);
              try {
                await navigator.clipboard.writeText(selected);
              } catch {
                // Continue with local text mutation even if clipboard write fails.
              }
              onInputChange(nextValue);
              bridge.saveDraft(nextValue);
              requestAnimationFrame(() => {
                textareaRef.current?.setSelectionRange(start, start);
              });
            }
            return;
          }
          if (key === "v") {
            e.preventDefault();
            try {
              const pastedText = await navigator.clipboard.readText();
              const start = el.selectionStart;
              const end = el.selectionEnd;
              const nextValue = input.slice(0, start) + pastedText + input.slice(end);
              const nextCursor = start + pastedText.length;
              onInputChange(nextValue);
              bridge.saveDraft(nextValue);
              requestAnimationFrame(() => {
                textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
              });
            } catch {
              // No-op if clipboard read is unavailable.
            }
            return;
          }
        }
      }

      if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        onSend();
        return;
      }
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onInterrupt();
        return;
      }
    },
    [pickers, input, onInputChange, bridge, onSend, onInterrupt],
  );

  const hasContent = input.trim().length > 0 || attachments.length > 0;

  return (
    <footer className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-gray-200">
      <AttachmentsList attachments={attachments} onRemove={removeAttachment} />

      <div
        ref={textareaContainerRef}
        className={`relative ${isDragging ? "ring-2 ring-blue-500 ring-offset-2 rounded-lg" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <CommandPicker
          isOpen={pickers.cmdActive}
          query={pickers.cmdQuery}
          filtered={pickers.cmdFiltered}
          selectedIndex={pickers.cmdSelectedIndex}
          onSelectedIndexChange={pickers.setCmdSelectedIndex}
          onPick={pickers.acceptCommandSelection}
        />

        <FilePicker
          isOpen={pickers.fileActive}
          query={pickers.fileQuery}
          filtered={pickers.fileFiltered}
          selectedIndex={pickers.fileSelectedIndex}
          onSelectedIndexChange={pickers.setFileSelectedIndex}
          onPick={pickers.acceptFileSelection}
        />

        <Bogart isQuerying={isQuerying} isTyping={isTyping} containerWidth={containerWidth} />

        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onSelect={pickers.handleSelect}
          onPaste={handlePaste}
          onBlur={handleBlur}
          placeholder={
            isConnected
              ? "Type a message... (⌘↵ send, ESC stop)"
              : "Disconnected - type to compose (will send when reconnected)"
          }
          className={`w-full p-3 pr-12 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-gray-300 ${!isConnected ? "bg-orange-50 border-orange-200" : ""}`}
          rows={1}
          style={{ minHeight: "96px", maxHeight: "200px", overflow: "auto" }}
        />

        <ContextRing usage={usage} />

        <SendStopButton
          isQuerying={isQuerying}
          hasContent={hasContent}
          isConnected={isConnected}
          onSend={onSend}
          onInterrupt={onInterrupt}
        />

        {isDragging && (
          <div className="absolute inset-0 bg-blue-50/80 rounded-lg flex items-center justify-center pointer-events-none">
            <span className="text-blue-600 font-medium">Drop files here</span>
          </div>
        )}
      </div>

      <GitStatusBar status={gitStatus ?? null} />
    </footer>
  );
}
