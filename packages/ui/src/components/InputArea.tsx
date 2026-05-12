import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { FileText, FileImage, File, X, ArrowUp } from "lucide-react";
import type { Attachment, Usage } from "../types";
import { useBridge } from "../bridge";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { useCommands, type CommandItem } from "../hooks/useCommands";
import { useFiles } from "../hooks/useFiles";
import { Bogart } from "./Bogart";
import { CommandPicker, filterCommands, type FilteredItem } from "./CommandPicker";
import { FilePicker, filterFiles, type FilteredFile } from "./FilePicker";
import { applyMentionSelection, findActiveMention, type ActiveMention } from "./file-mention";
import { GitStatusBar } from "./GitStatusBar";
import type { GitStatusInfo } from "../hooks/useChatGateway";

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
  gitStatus?: GitStatusInfo | null;
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
  gitStatus,
}: InputAreaProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [containerWidth, setContainerWidth] = useState(600);
  // ── slash picker state ──
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const [cmdSelectedIndex, setCmdSelectedIndex] = useState(0);
  const cmdFilteredRef = useRef<FilteredItem[]>([]);
  // ── file picker state ──
  const [fileDismissed, setFileDismissed] = useState(false);
  const [fileSelectedIndex, setFileSelectedIndex] = useState(0);
  const [cursorTick, setCursorTick] = useState(0); // bumps on any cursor move
  const fileFilteredRef = useRef<FilteredFile[]>([]);
  const fileMentionRef = useRef<ActiveMention | null>(null);
  // ── shared refs ──
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaContainerRef = useRef<HTMLDivElement>(null);
  const cursorPositionRef = useRef<{ start: number; end: number } | null>(null);
  const hadFocusBeforeDisconnectRef = useRef(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bridge = useBridge();
  const workspace = useWorkspace();
  const { items: commandItems } = useCommands(workspace.cwd);
  const { files } = useFiles(workspace.cwd);
  const isTauriRuntime = typeof window !== "undefined" && "__TAURI__" in window;

  // ── Slash-command picker ──────────────────────────────────────────
  // Opens when input starts with `/` AND there's no whitespace yet (so
  // `/podcast some args` doesn't keep the picker hovering during arg entry).
  // Resets on full-clear so re-typing `/` re-opens.
  const cmdActive = input.startsWith("/") && !/\s/.test(input) && !cmdDismissed;
  const cmdQuery = cmdActive ? input.slice(1) : "";
  const cmdFiltered = useMemo(
    () => (cmdActive ? filterCommands(commandItems, cmdQuery) : []),
    [cmdActive, commandItems, cmdQuery],
  );
  cmdFilteredRef.current = cmdFiltered;
  useEffect(() => {
    setCmdSelectedIndex(0);
  }, [cmdFiltered.length, cmdQuery]);

  // ── File `@` picker ───────────────────────────────────────────────
  // Active when there's a valid `@<query>` mention at the cursor — see
  // `findActiveMention` for the trigger rules (whitespace/backtick/BOF before).
  // Recomputed on every input change AND every cursor move (cursorTick).
  const fileMention = useMemo<ActiveMention | null>(() => {
    const cursor = cursorPositionRef.current?.start ?? input.length;
    return findActiveMention(input, cursor);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cursorTick is the cursor signal
  }, [input, cursorTick]);
  fileMentionRef.current = fileMention;
  const fileActive = fileMention !== null && !fileDismissed;
  const fileQuery = fileMention?.query ?? "";
  const fileFiltered = useMemo(
    () => (fileActive ? filterFiles(files, fileQuery) : []),
    [fileActive, files, fileQuery],
  );
  fileFilteredRef.current = fileFiltered;
  useEffect(() => {
    setFileSelectedIndex(0);
  }, [fileFiltered.length, fileQuery]);

  // ── Selection handlers ────────────────────────────────────────────
  const acceptCommandSelection = useCallback(
    (item: CommandItem) => {
      onInputChange(`/${item.name} `);
      bridge.saveDraft(`/${item.name} `);
      setCmdDismissed(true);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [bridge, onInputChange],
  );

  const acceptFileSelection = useCallback(
    (path: string) => {
      const mention = fileMentionRef.current;
      if (!mention) return;
      const next = applyMentionSelection(input, mention, path);
      onInputChange(next.input);
      bridge.saveDraft(next.input);
      setFileDismissed(true);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.cursorPos, next.cursorPos);
        // Re-arm: clear dismissal once the user moves on so the next `@` works.
        setFileDismissed(false);
      });
    },
    [bridge, input, onInputChange],
  );

  // Track cursor position on selection changes (arrow keys, mouse clicks).
  // Bumps `cursorTick` so the file-mention memo re-runs.
  const handleSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    cursorPositionRef.current = { start: el.selectionStart, end: el.selectionEnd };
    setCursorTick((t) => t + 1);
  }, []);

  // Track container width for Bogart's walking bounds
  useEffect(() => {
    const el = textareaContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Auto-resize textarea to fit content. The two assignments can't be batched
  // — we must reset to `auto` first so the second read of `scrollHeight`
  // reflects the new content height, not the previous explicit height.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // react-doctor-disable-next-line react-doctor/js-batch-dom-css
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
      const timer = setTimeout(() => {
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
      return () => clearTimeout(timer);
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
      const isImage = file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name);

      if (isImage) {
        // Client-side image compression: resize to 1600x1600, convert to JPEG
        // This handles HEIC/HEIF from iPhones and reduces payload before WebSocket send
        const MAX_DIM = 1600;
        const QUALITY = 0.85;

        const img = new Image();
        const objectUrl = URL.createObjectURL(file);

        img.onload = () => {
          URL.revokeObjectURL(objectUrl);

          let { width, height } = img;

          // Scale down if needed, maintaining aspect ratio
          if (width > MAX_DIM || height > MAX_DIM) {
            const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }

          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx2d = canvas.getContext("2d");
          if (!ctx2d) return;
          ctx2d.drawImage(img, 0, 0, width, height);

          // Convert to JPEG (handles HEIC/HEIF/WebP/PNG → JPEG)
          const dataUrl = canvas.toDataURL("image/jpeg", QUALITY);
          const data = dataUrl.split(",")[1];

          onAttachmentsChange([
            ...attachments,
            {
              type: "image",
              mediaType: "image/jpeg",
              data,
              filename: file.name.replace(/\.(heic|heif)$/i, ".jpg"),
            },
          ]);
        };

        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          // Fallback: send raw file if canvas can't handle the format
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const [header, data] = dataUrl.split(",");
            const mediaType = header.match(/data:(.*?);/)?.[1] || "application/octet-stream";
            onAttachmentsChange([
              ...attachments,
              {
                type: "image",
                mediaType,
                data,
                filename: file.name,
              },
            ]);
          };
          reader.readAsDataURL(file);
        };

        img.src = objectUrl;
      } else {
        // Non-image files: read as-is
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const [header, data] = dataUrl.split(",");
          const mediaType = header.match(/data:(.*?);/)?.[1] || "application/octet-stream";
          onAttachmentsChange([
            ...attachments,
            {
              type: "file",
              mediaType,
              data,
              filename: file.name,
            },
          ]);
        };
        reader.readAsDataURL(file);
      }
    },
    [attachments, onAttachmentsChange],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      for (const item of items) {
        if (
          item.type.startsWith("image/") ||
          item.type === "image/heic" ||
          item.type === "image/heif" ||
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

      // Track typing state for Bogart
      setIsTyping(true);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => setIsTyping(false), 2000);

      // Reset both pickers' dismissal when input clears — re-typing `/` or `@`
      // should re-open them.
      if (value === "") {
        setCmdDismissed(false);
        setFileDismissed(false);
      }

      // Save cursor position on every change + bump tick so file-mention recomputes
      cursorPositionRef.current = {
        start: e.target.selectionStart,
        end: e.target.selectionEnd,
      };
      setCursorTick((t) => t + 1);
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
      // ── Picker key handling ──────────────────────────────────────────
      // When either picker is open and has results, intercept nav + accept
      // keys before the rest of the textarea handlers see them. The two
      // pickers are mutually exclusive given the trigger rules, so a single
      // dispatch is safe.
      const cmdOpen = cmdActive && cmdFilteredRef.current.length > 0;
      const fileOpen = fileActive && fileFilteredRef.current.length > 0;
      if (cmdOpen || fileOpen) {
        const len = cmdOpen ? cmdFilteredRef.current.length : fileFilteredRef.current.length;
        const setIdx = cmdOpen ? setCmdSelectedIndex : setFileSelectedIndex;

        if (e.key === "ArrowDown") {
          e.preventDefault();
          setIdx((i) => (i + 1) % len);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setIdx((i) => (i - 1 + len) % len);
          return;
        }
        // Accept keys differ between pickers:
        //   - Command picker: Tab / Enter / Space all accept (matches TUI feel)
        //   - File picker: only Tab / Enter — space is part of the query so the
        //     user can chunk with multi-token search ("input area")
        const isAcceptKey = e.key === "Enter" || e.key === "Tab" || (cmdOpen && e.key === " ");
        if (isAcceptKey) {
          // Bare-trigger space pass-through for the command picker: `/ thought`
          // should let the space land literally.
          if (cmdOpen && e.key === " " && cmdQuery.length === 0) return;
          e.preventDefault();
          if (cmdOpen) {
            const picked = cmdFilteredRef.current[cmdSelectedIndex];
            if (picked) acceptCommandSelection(picked.item);
          } else {
            const picked = fileFilteredRef.current[fileSelectedIndex];
            if (picked) acceptFileSelection(picked.path);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          if (cmdOpen) setCmdDismissed(true);
          else setFileDismissed(true);
          return;
        }
      }

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
    [
      acceptCommandSelection,
      acceptFileSelection,
      bridge,
      cmdActive,
      cmdQuery,
      cmdSelectedIndex,
      fileActive,
      fileQuery,
      fileSelectedIndex,
      input,
      isTauriRuntime,
      onInputChange,
      onInterrupt,
      onSend,
    ],
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
            // Content-derived key — Attachment has no stable id and a single
            // message can carry multiple files with identical names/types, so
            // hash a slice of the base64 data for uniqueness within the list.
            const key = `${attachment.type}:${attachment.filename ?? ""}:${attachment.data.slice(0, 24)}`;
            return (
              <div key={key} className="relative group">
                {attachment.type === "image" ? (
                  <img
                    src={`data:${attachment.mediaType};base64,${attachment.data}`}
                    alt={attachment.filename || `Attachment ${idx + 1}`}
                    className="size-16 object-cover rounded-md border border-gray-300"
                  />
                ) : (
                  <div className="h-16 px-3 flex items-center gap-2 rounded-md border border-gray-300 bg-gray-50">
                    <FileIcon className="size-5 text-gray-500" />
                    <span className="text-xs text-gray-700 max-w-24 truncate">
                      {attachment.filename || "file"}
                    </span>
                  </div>
                )}
                <button
                  onClick={() => removeAttachment(idx)}
                  className="absolute -top-1 -right-1 size-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Textarea with integrated send/stop button */}
      <div
        ref={textareaContainerRef}
        className={`relative ${isDragging ? "ring-2 ring-blue-500 ring-offset-2 rounded-lg" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Skill / slash-command picker — anchored above the textarea */}
        <CommandPicker
          isOpen={cmdActive}
          items={commandItems}
          query={cmdQuery}
          selectedIndex={cmdSelectedIndex}
          onSelectedIndexChange={setCmdSelectedIndex}
          onPick={acceptCommandSelection}
        />

        {/* File `@` picker — anchored above the textarea */}
        <FilePicker
          isOpen={fileActive}
          files={files}
          query={fileQuery}
          selectedIndex={fileSelectedIndex}
          onSelectedIndexChange={setFileSelectedIndex}
          onPick={acceptFileSelection}
        />

        {/* Bogart the cat 🐱 */}
        <Bogart isQuerying={isQuerying} isTyping={isTyping} containerWidth={containerWidth} />
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onSelect={handleSelect}
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

        {/* Send/Stop button — show send (blue) if there's text to send, even while querying.
             Only show stop (red) when querying AND input is empty. */}
        {(() => {
          const hasContent = input.trim().length > 0 || attachments.length > 0;
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
        })()}

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
