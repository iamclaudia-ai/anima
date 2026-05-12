import { useEffect, type RefObject } from "react";

/**
 * Auto-resize a textarea to fit its content as `value` changes.
 *
 * The two height writes can't be batched: we must reset to `auto` first so
 * the subsequent `scrollHeight` read reflects the new content height, not the
 * previous explicit height.
 */
export function useTextareaAutosize(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    // react-doctor-disable-next-line react-doctor/js-batch-dom-css
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}
