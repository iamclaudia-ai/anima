import { useState, type ReactNode } from "react";

interface CollapsibleToolProps {
  collapsedContent: ReactNode;
  expandedContent: ReactNode | null;
  defaultExpanded?: boolean;
  /** Kept for prop-compat with tool components — spinner is now rendered
   *  inside the collapsed content's ToolHeader, not in this component. */
  isLoading?: boolean;
  toolName?: string;
}

/**
 * Vertical timeline row: bare icon + label, optional inline-expanded panel.
 * No pill background, no chevron, no trailing spinner — the spinner lives
 * inside ToolHeader (in place of the tool icon) when isLoading is true.
 */
export function CollapsibleTool({
  collapsedContent,
  expandedContent,
  defaultExpanded = false,
}: CollapsibleToolProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const hasExpandedContent = expandedContent !== null && expandedContent !== undefined;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (!hasExpandedContent) return;
          setIsExpanded((v) => !v);
        }}
        disabled={!hasExpandedContent}
        aria-expanded={isExpanded}
        className={`flex w-full items-center gap-1.5 text-left ${
          hasExpandedContent ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <div className="min-w-0">{collapsedContent}</div>
      </button>
      {isExpanded && hasExpandedContent && (
        <div className="mt-1 ml-6">
          <div className="rounded-md border border-neutral-200 bg-white p-3 space-y-1.5">
            {expandedContent}
          </div>
        </div>
      )}
    </>
  );
}
