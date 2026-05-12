import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { filterCommands, type FilteredItem as FilteredCommand } from "../components/CommandPicker";
import { filterFiles, type FilteredFile } from "../components/FilePicker";
import {
  applyMentionSelection,
  findActiveMention,
  type ActiveMention,
} from "../components/file-mention";
import type { CommandItem } from "./useCommands";

/**
 * `useInputPickers` — combined state machine for the slash-command picker
 * and the `@` file picker in the chat textarea.
 *
 * The two pickers are mutually exclusive given their trigger rules (the
 * slash picker requires `/` at BOF with no whitespace; the file picker
 * requires `@` preceded by whitespace/backtick/BOF). This hook owns:
 *
 *   - dismissal state for each (re-armed on input clear)
 *   - selectedIndex for each
 *   - cursor tracking (selectionchange events)
 *   - the active/query/filtered derivations
 *   - the keyboard dispatcher (Arrow/Tab/Enter/Space/Escape)
 *   - acceptance handlers that update input + close the picker
 *
 * Issue #30 fix: filtering is gated on `active` here, so an empty/stale
 * query no longer makes the picker components churn fuzzysort over the
 * full catalog when they're not open. After acceptance we DO NOT re-arm
 * inside a RAF — instead the picker re-arms when the user clears the input
 * or types past the inserted mention (handled implicitly by `findActiveMention`
 * returning null at the new cursor).
 */

interface UseInputPickersParams {
  input: string;
  onInputChange(value: string): void;
  saveDraft(value: string): void;
  commandItems: CommandItem[];
  files: string[];
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

export interface UseInputPickersReturn {
  // — Slash-command picker —
  cmdActive: boolean;
  cmdQuery: string;
  cmdFiltered: FilteredCommand[];
  cmdSelectedIndex: number;
  setCmdSelectedIndex: Dispatch<SetStateAction<number>>;
  acceptCommandSelection(item: CommandItem): void;

  // — File `@` picker —
  fileActive: boolean;
  fileQuery: string;
  fileFiltered: FilteredFile[];
  fileSelectedIndex: number;
  setFileSelectedIndex: Dispatch<SetStateAction<number>>;
  acceptFileSelection(path: string): void;

  // — Shared cursor tracking —
  /** Stable ref to the latest cursor position. Survives re-renders. */
  cursorPositionRef: React.RefObject<{ start: number; end: number } | null>;
  /** Wire to <textarea onSelect=>. */
  handleSelect(e: React.SyntheticEvent<HTMLTextAreaElement>): void;
  /** Wire to <textarea onChange=> (call after parent's onInputChange/saveDraft). */
  notifyInputChange(value: string, cursor: { start: number; end: number }): void;

  /**
   * Keyboard dispatcher for picker navigation. Returns `true` if the event
   * was handled and the caller should bail out of further key handling.
   */
  handlePickerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean;
}

export function useInputPickers({
  input,
  onInputChange,
  saveDraft,
  commandItems,
  files,
  textareaRef,
}: UseInputPickersParams): UseInputPickersReturn {
  // ── dismissal flags ─────────────────────────────────────────────────────
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const [fileDismissed, setFileDismissed] = useState(false);

  // ── selected index (resets when filtered list shape/query changes) ──────
  const [cmdSelectedIndex, setCmdSelectedIndex] = useState(0);
  const [fileSelectedIndex, setFileSelectedIndex] = useState(0);

  // ── cursor tracking — `cursorTick` is the signal for re-evaluating
  //    `findActiveMention` after pure cursor moves (arrow keys, clicks). ──
  const [cursorTick, setCursorTick] = useState(0);
  const cursorPositionRef = useRef<{ start: number; end: number } | null>(null);

  // ── active / query / filtered for slash-command picker ──────────────────
  // `cmdMatchesTrigger` is the "input still looks like a slash command"
  // signal independent of dismissal. We watch it transition to false so we
  // can auto-re-arm dismissal — without that, accepting a command would
  // leave `cmdDismissed=true` permanently for that input.
  const cmdMatchesTrigger = input.startsWith("/") && !/\s/.test(input);
  const cmdActive = cmdMatchesTrigger && !cmdDismissed;
  const cmdQuery = cmdActive ? input.slice(1) : "";
  useEffect(() => {
    if (!cmdMatchesTrigger) setCmdDismissed(false);
  }, [cmdMatchesTrigger]);
  const cmdFiltered = useMemo(
    () => (cmdActive ? filterCommands(commandItems, cmdQuery) : []),
    [cmdActive, commandItems, cmdQuery],
  );
  const cmdFilteredRef = useRef<FilteredCommand[]>(cmdFiltered);
  cmdFilteredRef.current = cmdFiltered;

  useEffect(() => {
    setCmdSelectedIndex(0);
  }, [cmdFiltered.length, cmdQuery]);

  // ── active / query / filtered for file `@` picker ───────────────────────
  // The mention is derived from input + cursorTick — cursor moves can change
  // whether we're inside a valid `@<query>` even when input is unchanged.
  const fileMention = useMemo<ActiveMention | null>(() => {
    const cursor = cursorPositionRef.current?.start ?? input.length;
    return findActiveMention(input, cursor);
    // cursorTick is the cursor-move signal; including it intentionally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, cursorTick]);
  const fileMentionRef = useRef<ActiveMention | null>(fileMention);
  fileMentionRef.current = fileMention;

  const fileActive = fileMention !== null && !fileDismissed;
  const fileQuery = fileMention?.query ?? "";
  // Auto-re-arm dismissal once the cursor leaves any active mention. This
  // replaces the original RAF-based re-arm in `acceptFileSelection`, which
  // raced cursor updates and caused the picker to briefly flash back open
  // after acceptance (Issue #30).
  useEffect(() => {
    if (fileMention === null) setFileDismissed(false);
  }, [fileMention]);
  const fileFiltered = useMemo(
    () => (fileActive ? filterFiles(files, fileQuery) : []),
    [fileActive, files, fileQuery],
  );
  const fileFilteredRef = useRef<FilteredFile[]>(fileFiltered);
  fileFilteredRef.current = fileFiltered;

  useEffect(() => {
    setFileSelectedIndex(0);
  }, [fileFiltered.length, fileQuery]);

  // ── notifyInputChange: parent calls after onInputChange/saveDraft ───────
  // Just records cursor + bumps the tick. Dismissal re-arming is handled
  // by the effects above watching `cmdMatchesTrigger` and `fileMention`.
  const notifyInputChange = useCallback(
    (_value: string, cursor: { start: number; end: number }) => {
      cursorPositionRef.current = cursor;
      setCursorTick((t) => t + 1);
    },
    [],
  );

  // ── handleSelect: track cursor on arrow keys / clicks ───────────────────
  const handleSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    cursorPositionRef.current = { start: el.selectionStart, end: el.selectionEnd };
    setCursorTick((t) => t + 1);
  }, []);

  // ── acceptance handlers ─────────────────────────────────────────────────
  const acceptCommandSelection = useCallback(
    (item: CommandItem) => {
      const next = `/${item.name} `;
      onInputChange(next);
      saveDraft(next);
      setCmdDismissed(true);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [onInputChange, saveDraft, textareaRef],
  );

  const acceptFileSelection = useCallback(
    (path: string) => {
      const mention = fileMentionRef.current;
      if (!mention) return;
      const next = applyMentionSelection(input, mention, path);
      onInputChange(next.input);
      saveDraft(next.input);
      // Mark the picker dismissed for this mention. The auto-re-arm effect
      // above will reset this flag once the cursor moves out of any mention
      // region. (Issue #30: the original code re-armed inside a RAF, which
      // raced cursor updates and made the picker flash back open while the
      // user's next keystrokes were still being processed.)
      setFileDismissed(true);
      // Update the cursor ref immediately so the next memo computation sees
      // the post-insertion cursor — and so the `fileMention` derivation can
      // pick up the new state without waiting for the textarea's own
      // selectionchange event.
      cursorPositionRef.current = { start: next.cursorPos, end: next.cursorPos };
      setCursorTick((t) => t + 1);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.cursorPos, next.cursorPos);
      });
    },
    [input, onInputChange, saveDraft, textareaRef],
  );

  // ── keyboard dispatcher ─────────────────────────────────────────────────
  const handlePickerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      const cmdOpen = cmdActive && cmdFilteredRef.current.length > 0;
      const fileOpen = fileActive && fileFilteredRef.current.length > 0;
      if (!cmdOpen && !fileOpen) return false;

      const len = cmdOpen ? cmdFilteredRef.current.length : fileFilteredRef.current.length;
      const setIdx = cmdOpen ? setCmdSelectedIndex : setFileSelectedIndex;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIdx((i) => (i + 1) % len);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIdx((i) => (i - 1 + len) % len);
        return true;
      }

      // Accept keys differ between pickers:
      //   - Command picker: Tab / Enter / Space all accept (matches TUI feel)
      //   - File picker: only Tab / Enter — space is part of the query so the
      //     user can chunk with multi-token search ("input area")
      const isAcceptKey = e.key === "Enter" || e.key === "Tab" || (cmdOpen && e.key === " ");
      if (isAcceptKey) {
        // Bare-trigger space pass-through for the command picker: `/ thought`
        // should let the space land literally.
        if (cmdOpen && e.key === " " && cmdQuery.length === 0) return false;
        e.preventDefault();
        if (cmdOpen) {
          const picked = cmdFilteredRef.current[cmdSelectedIndex];
          if (picked) acceptCommandSelection(picked.item);
        } else {
          const picked = fileFilteredRef.current[fileSelectedIndex];
          if (picked) acceptFileSelection(picked.path);
        }
        return true;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        if (cmdOpen) setCmdDismissed(true);
        else setFileDismissed(true);
        return true;
      }
      return false;
    },
    [
      cmdActive,
      cmdQuery,
      cmdSelectedIndex,
      fileActive,
      fileSelectedIndex,
      acceptCommandSelection,
      acceptFileSelection,
    ],
  );

  return {
    cmdActive,
    cmdQuery,
    cmdFiltered,
    cmdSelectedIndex,
    setCmdSelectedIndex,
    acceptCommandSelection,
    fileActive,
    fileQuery,
    fileFiltered,
    fileSelectedIndex,
    setFileSelectedIndex,
    acceptFileSelection,
    cursorPositionRef,
    handleSelect,
    notifyInputChange,
    handlePickerKeyDown,
  };
}
