import { Children, type ReactNode } from "react";

interface ToolTimelineProps {
  children: ReactNode;
}

/**
 * Renders a vertical timeline of tool-call / thinking items with thin
 * gray connecting lines between them. Each child renders as its bare
 * icon + label row; a short vertical bar is drawn in the gap below
 * each item (except the last), aligned to the icon column.
 */
export function ToolTimeline({ children }: ToolTimelineProps) {
  const items = Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;

  return (
    <ul className="my-1 list-none p-0">
      {items.map((child, i) => {
        // Children.toArray assigns each child a stable .key; reuse it so
        // sibling <li>s share the same identity as their wrapped content.
        const childKey = (child as { key?: string | null }).key;
        return (
          <li key={childKey ?? `tt-${i}`}>
            {child}
            {i < items.length - 1 && (
              <div aria-hidden="true" className="ml-[6px] my-1 h-3 w-px bg-gray-300" />
            )}
          </li>
        );
      })}
    </ul>
  );
}
