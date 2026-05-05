/**
 * useIsMobile — reactive media-query hook for mobile-vs-desktop layout switches.
 *
 * Used by the router to pick `LayoutDefinition.mobile` vs `LayoutDefinition.default`,
 * and exported so panel components can adapt their internal rendering (e.g., a
 * file tree that becomes a tab on mobile).
 *
 * Default breakpoint: 768px (Tailwind's `md`). Pass a custom breakpoint to
 * match your component's internal threshold if it differs.
 */

import { useEffect, useState } from "react";

export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);

  return isMobile;
}
