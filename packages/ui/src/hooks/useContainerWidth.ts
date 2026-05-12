import { useEffect, useState, type RefObject } from "react";

/**
 * Track the width of a DOM element via ResizeObserver. Used by Bogart to know
 * the textarea's bounds when calculating walking distance.
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>, initial = 600): number {
  const [width, setWidth] = useState(initial);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
