import { useState, useCallback, useRef, useEffect } from "react";
import { FileText, FileImage, File, X, ArrowUp } from "lucide-react";
import type { Attachment, Usage } from "../types";
import { useBridge } from "../bridge";

function getFileIcon(mediaType: string) {
  if (mediaType.startsWith("image/")) return FileImage;
  if (mediaType.startsWith("text/") || mediaType === "application/pdf") return FileText;
  return File;
}

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
}

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
}: InputAreaProps) {
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cursorPositionRef = useRef<{ start: number; end: number } | null>(null);
  const hadFocusBeforeDisconnectRef = useRef(false);
  const bridge = useBridge();
  const isTauriRuntime = typeof window !== "undefined" && "__TAURI__" in window;

  // Auto-resize textarea to fit content
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Maintain focus on mount and when connection is restored
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      // Focus on mount
      el.focus();
    }
  }, []);

  // Restore focus when reconnected (but only if we had focus before disconnect)
  useEffect(() => {
    const el = textareaRef.current;
    if (isConnected && el && hadFocusBeforeDisconnectRef.current && document.activeElement !== el) {
      // Small delay to ensure UI has updated
      setTimeout(() => {
        // Save the cursor position before focusing
        const savedPosition = cursorPositionRef.current;
        el.focus();
        // Restore cursor position after focus, with another small delay
        if (savedPosition) {
          // Use requestAnimationFrame to ensure focus is fully applied
          requestAnimationFrame(() => {
            el.setSelectionRange(savedPosition.start, savedPosition.end);
          });
        }
      }, 50);
    }
  }, [isConnected]);

  // Save cursor position when connection is lost
  useEffect(() => {
    const el = textareaRef.current;
    if (!isConnected && el) {
      const hadFocus = document.activeElement === el;
      hadFocusBeforeDisconnectRef.current = hadFocus;

      if (hadFocus) {
        // Save current cursor position
        cursorPositionRef.current = {
          start: el.selectionStart,
          end: el.selectionEnd,
        };
      }
    } else if (isConnected) {
      // Clear the flag when reconnected
      hadFocusBeforeDisconnectRef.current = false;
    }
  }, [isConnected]);

  const processFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const [header, data] = dataUrl.split(",");
        const mediaType = header.match(/data:(.*?);/)?.[1] || "application/octet-stream";
        const isImage = mediaType.startsWith("image/");
        onAttachmentsChange([
          ...attachments,
          {
            type: isImage ? "image" : "file",
            mediaType,
            data,
            filename: file.name,
          },
        ]);
      };
      reader.readAsDataURL(file);
    },
    [attachments, onAttachmentsChange],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      for (const item of items) {
        if (
          item.type.startsWith("image/") ||
          item.type.startsWith("text/") ||
          item.type === "application/pdf"
        ) {
          const file = item.getAsFile();
          if (!file) continue;
          e.preventDefault();
          processFile(file);
        }
      }
    },
    [processFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        processFile(file);
      }
    },
    [processFile],
  );

  const removeAttachment = useCallback(
    (index: number) => {
      onAttachmentsChange(attachments.filter((_, i) => i !== index));
    },
    [attachments, onAttachmentsChange],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      onInputChange(value);
      bridge.saveDraft(value);

      // Save cursor position on every change
      cursorPositionRef.current = {
        start: e.target.selectionStart,
        end: e.target.selectionEnd,
      };
    },
    [onInputChange, bridge],
  );

  const handleBlur = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      // Save cursor position when losing focus
      cursorPositionRef.current = {
        start: el.selectionStart,
        end: el.selectionEnd,
      };
    }
  }, []);

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Tauri/macOS fallback: ensure common Cmd shortcuts work in the prompt textarea.
      if (isTauriRuntime && e.metaKey && !e.ctrlKey && !e.altKey) {
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
    [bridge, input, isTauriRuntime, onInputChange, onInterrupt, onSend],
  );

  // Calculate context usage for the ring indicator
  const contextData = usage
    ? (() => {
        const total =
          usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
        const max = 200000;
        const percent = (total / max) * 100;
        // Use lighter gray for 0%, color coded for usage levels
        const strokeColor =
          percent === 0
            ? "#d1d5db" // gray-300 (lighter gray for zero state)
            : percent >= 80
              ? "#dc2626" // red-600
              : percent >= 60
                ? "#f97316" // orange-500
                : "#10b981"; // emerald-500
        return { total, max, percent, strokeColor };
      })()
    : null;

  return (
    <footer className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-gray-200">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((attachment, idx) => {
            const FileIcon = getFileIcon(attachment.mediaType);
            return (
              <div key={idx} className="relative group">
                {attachment.type === "image" ? (
                  <img
                    src={`data:${attachment.mediaType};base64,${attachment.data}`}
                    alt={attachment.filename || `Attachment ${idx + 1}`}
                    className="h-16 w-16 object-cover rounded-md border border-gray-300"
                  />
                ) : (
                  <div className="h-16 px-3 flex items-center gap-2 rounded-md border border-gray-300 bg-gray-50">
                    <FileIcon className="w-5 h-5 text-gray-500" />
                    <span className="text-xs text-gray-700 max-w-24 truncate">
                      {attachment.filename || "file"}
                    </span>
                  </div>
                )}
                <button
                  onClick={() => removeAttachment(idx)}
                  className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Textarea with integrated send/stop button */}
      <div
        className={`relative ${isDragging ? "ring-2 ring-blue-500 ring-offset-2 rounded-lg" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
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

        {/* Context ring indicator - positioned above send/stop button */}
        {contextData && (
          <div className="absolute bottom-14 right-2 flex flex-col items-center">
            <svg width="32" height="32" viewBox="0 0 32 32">
              {/* Background ring (darker gray) */}
              <circle
                cx="16"
                cy="16"
                r="14"
                fill="none"
                stroke="#9ca3af"
                strokeWidth="2.5"
                className="transform -rotate-90 origin-center"
                style={{ transformOrigin: "16px 16px" }}
              />
              {/* Progress ring (colored) */}
              <circle
                cx="16"
                cy="16"
                r="14"
                fill="none"
                stroke={contextData.strokeColor}
                strokeWidth="2.5"
                strokeDasharray={`${(contextData.percent / 100) * 87.96} 87.96`}
                strokeLinecap="round"
                className="transform -rotate-90 origin-center"
                style={{ transformOrigin: "16px 16px" }}
              />
              {/* Percentage text in center - only show if non-zero */}
              {contextData.percent > 0 && (
                <text
                  x="16"
                  y="16"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-[9px] font-mono font-semibold fill-gray-600"
                >
                  {Math.round(contextData.percent)}
                </text>
              )}
            </svg>
          </div>
        )}

        {/* Send/Stop button - toggles based on isQuerying */}
        <button
          onClick={isQuerying ? onInterrupt : onSend}
          disabled={!isQuerying && (!isConnected || (!input.trim() && attachments.length === 0))}
          className={`absolute bottom-4 right-2 w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
            isQuerying
              ? "bg-red-500 hover:bg-red-600"
              : "bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
          } text-white`}
          aria-label={isQuerying ? "Stop" : "Send message"}
        >
          {isQuerying ? <X className="w-4 h-4" /> : <ArrowUp className="w-4 h-4" />}
        </button>

        {isDragging && (
          <div className="absolute inset-0 bg-blue-50/80 rounded-lg flex items-center justify-center pointer-events-none">
            <span className="text-blue-600 font-medium">Drop files here</span>
          </div>
        )}
      </div>
    </footer>
  );
}
