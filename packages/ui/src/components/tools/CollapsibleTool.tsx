import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { useId, useState, useRef, useEffect, type ReactNode } from "react";
import { getToolBadgeConfig } from "./toolConfig";
import { useInlineExpansion } from "../InlineExpansionProvider";

interface CollapsibleToolProps {
  collapsedContent: ReactNode;
  expandedContent: ReactNode | null;
  defaultExpanded?: boolean;
  isLoading?: boolean;
  toolName?: string;
}

export function CollapsibleTool({
  collapsedContent,
  expandedContent,
  defaultExpanded = false,
  isLoading = false,
  toolName,
}: CollapsibleToolProps) {
  const [fallbackExpanded, setFallbackExpanded] = useState(defaultExpanded);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inlineExpansion = useInlineExpansion();
  const expansionId = useId();
  const hasExpandedContent = expandedContent !== null && expandedContent !== undefined;
  const isExpanded = inlineExpansion ? inlineExpansion.isOpen(expansionId) : fallbackExpanded;

  // Close on click outside
  useEffect(() => {
    if (inlineExpansion) return;
    if (!isExpanded) return;
    function handleClick(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setFallbackExpanded(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [inlineExpansion, isExpanded]);

  // Get tool-specific colors for the container
  const config = toolName ? getToolBadgeConfig(toolName) : null;
  const chevronColor = config?.colors.chevron || "text-neutral-400";
  const containerBorder = config?.colors.border || "border-neutral-200/60";
  const containerBg = config?.colors.bg || "bg-neutral-50/80";
  const containerHover = config?.colors.hoverBg || "hover:bg-neutral-100/80";

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          if (!hasExpandedContent) return;
          if (inlineExpansion && buttonRef.current) {
            inlineExpansion.toggle({
              id: expansionId,
              anchorEl: buttonRef.current,
              content: <div className="space-y-1.5">{expandedContent}</div>,
            });
            return;
          }
          setFallbackExpanded(!fallbackExpanded);
        }}
        disabled={!hasExpandedContent && !isLoading}
        aria-expanded={isExpanded}
        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-left transition-colors ${containerBorder} ${containerBg} ${
          hasExpandedContent ? `cursor-pointer ${containerHover}` : "cursor-default"
        } ${isExpanded ? "ring-1 ring-neutral-300" : ""}`}
      >
        <div>{collapsedContent}</div>
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          {isLoading ? (
            <Loader2 className={`size-3 animate-spin ${chevronColor}`} />
          ) : hasExpandedContent ? (
            isExpanded ? (
              <ChevronUp className={`size-3 ${chevronColor}`} />
            ) : (
              <ChevronDown className={`size-3 ${chevronColor}`} />
            )
          ) : null}
        </span>
      </button>
      {!inlineExpansion && isExpanded && hasExpandedContent && (
        <div
          ref={popoverRef}
          className="absolute left-0 top-full z-20 mt-1 w-[min(600px,80vw)] rounded-lg border border-neutral-200 bg-white p-3 shadow-lg"
        >
          <div className="space-y-1.5">{expandedContent}</div>
        </div>
      )}
    </div>
  );
}
