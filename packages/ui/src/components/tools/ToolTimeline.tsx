import { Children, type ReactNode } from "react";
import { ToolVariantProvider } from "./ToolVariantContext";

interface ToolTimelineProps {
  children: ReactNode;
}

/**
 * Renders a vertical timeline of tool-call / thinking items with thin
 * gray connecting lines between them. Each item renders as a normal
 * collapsible badge — minus the pill container — and a short vertical
 * bar is drawn in the gap below it (except after the last item),
 * aligned to the icon column.
 */
export function ToolTimeline({ children }: ToolTimelineProps) {
  const items = Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;

  return (
    <ToolVariantProvider variant="timeline">
      <ul className="my-1 list-none p-0">
        {items.map((child, i) => (
          <li key={i}>
            {child}
            {i < items.length - 1 && (
              <div aria-hidden="true" className="ml-[6px] my-1 h-3 w-px bg-gray-300" />
            )}
          </li>
        ))}
      </ul>
    </ToolVariantProvider>
  );
}
