import { useEffect, useRef, type RefObject } from "react";

/**
 * Maintain textarea focus across mount and connection drops.
 *
 * On mount: focus the textarea.
 * On disconnect: record whether we had focus + save cursor position.
 * On reconnect: restore focus + cursor position (only if we had focus before).
 */
export function useFocusRestore(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  cursorPositionRef: RefObject<{ start: number; end: number } | null>,
  isConnected: boolean,
): void {
  const hadFocusBeforeDisconnectRef = useRef(false);

  // Focus on mount.
  useEffect(() => {
    textareaRef.current?.focus();
  }, [textareaRef]);

  // Save state on disconnect, restore on reconnect.
  useEffect(() => {
    const el = textareaRef.current;
    if (!isConnected && el) {
      const hadFocus = document.activeElement === el;
      hadFocusBeforeDisconnectRef.current = hadFocus;
      if (hadFocus) {
        cursorPositionRef.current = { start: el.selectionStart, end: el.selectionEnd };
      }
      return;
    }
    if (isConnected && el && hadFocusBeforeDisconnectRef.current && document.activeElement !== el) {
      const timer = setTimeout(() => {
        const savedPosition = cursorPositionRef.current;
        el.focus();
        if (savedPosition) {
          requestAnimationFrame(() => {
            el.setSelectionRange(savedPosition.start, savedPosition.end);
          });
        }
      }, 50);
      hadFocusBeforeDisconnectRef.current = false;
      return () => clearTimeout(timer);
    }
  }, [isConnected, textareaRef, cursorPositionRef]);
}
