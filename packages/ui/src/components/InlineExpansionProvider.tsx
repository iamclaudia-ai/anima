import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

type OpenExpansion = {
  id: string;
  anchorEl: HTMLElement;
  content: ReactNode;
};

type InlineExpansionContextValue = {
  isOpen: (id: string) => boolean;
  toggle: (expansion: OpenExpansion) => void;
  close: () => void;
};

const InlineExpansionContext = createContext<InlineExpansionContextValue | null>(null);

interface InlineExpansionProviderProps {
  containerRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function InlineExpansionProvider({ containerRef, children }: InlineExpansionProviderProps) {
  const [open, setOpen] = useState<OpenExpansion | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(
    null,
  );

  const close = useCallback(() => setOpen(null), []);

  const toggle = useCallback((next: OpenExpansion) => {
    setOpen((current) => (current?.id === next.id ? null : next));
  }, []);

  const isOpen = useCallback((id: string) => open?.id === id, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    const anchorEl = open.anchorEl;
    const containerEl = containerRef.current;
    if (!containerEl || !anchorEl.isConnected) {
      setOpen(null);
      return;
    }

    const updatePosition = () => {
      const containerRect = containerEl.getBoundingClientRect();
      const anchorRect = anchorEl.getBoundingClientRect();
      const style = window.getComputedStyle(containerEl);
      const paddingLeft = Number.parseFloat(style.paddingLeft || "0") || 0;
      const paddingRight = Number.parseFloat(style.paddingRight || "0") || 0;
      const left = containerRect.left + paddingLeft;
      const width = Math.max(280, containerRect.width - paddingLeft - paddingRight);
      const top = anchorRect.bottom + 6;
      setPosition({ left, top, width });
    };

    updatePosition();

    const onResize = () => updatePosition();
    const onScroll = () => updatePosition();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, containerRef]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const panel = document.getElementById("claudia-inline-expansion-panel");
      const inPanel = !!panel?.contains(target);
      const inAnchor = open.anchorEl.contains(target);
      if (!inPanel && !inAnchor) close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, close]);

  const value = useMemo<InlineExpansionContextValue>(
    () => ({ isOpen, toggle, close }),
    [isOpen, toggle, close],
  );

  return (
    <InlineExpansionContext.Provider value={value}>
      {children}
      {open &&
        position &&
        createPortal(
          <div
            id="claudia-inline-expansion-panel"
            className="fixed z-50 rounded-lg border border-neutral-200 bg-white p-3 shadow-lg max-h-[55vh] overflow-auto"
            style={{
              left: `${position.left}px`,
              top: `${position.top}px`,
              width: `${position.width}px`,
            }}
          >
            {open.content}
          </div>,
          document.body,
        )}
    </InlineExpansionContext.Provider>
  );
}

export function useInlineExpansion() {
  return useContext(InlineExpansionContext);
}
