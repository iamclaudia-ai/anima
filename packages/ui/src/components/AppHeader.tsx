/**
 * AppHeader — Global chrome rendered above each layout-based route.
 *
 * Three segments — left / center / right — populated dynamically by panels
 * via `useHeaderSlot()`. The header itself just reads from the context;
 * panels own the content, ordering hints, and visibility.
 *
 * Per-segment ordering: `(order asc, id asc)`. Layout/styling is intentionally
 * minimal in this first cut — we'll iterate on visuals once we see the
 * pieces in place.
 */

import { useMemo } from "react";
import {
  useHeaderSlots,
  type HeaderSegment,
  type HeaderSlot,
} from "../contexts/HeaderSlotsContext";

function pickAndSort(slots: HeaderSlot[], segment: HeaderSegment): HeaderSlot[] {
  return slots
    .filter((s) => s.segment === segment)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function slotKey(slot: HeaderSlot): string {
  return `${slot.segment}:${slot.id}`;
}

export function AppHeader() {
  const slots = useHeaderSlots();
  const left = useMemo(() => pickAndSort(slots, "left"), [slots]);
  const center = useMemo(() => pickAndSort(slots, "center"), [slots]);
  const right = useMemo(() => pickAndSort(slots, "right"), [slots]);

  return (
    <header className="flex h-12 shrink-0 items-center border-b border-gray-200 bg-gradient-to-r from-purple-100 via-indigo-100 to-blue-100 px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {left.map((s) => (
          <span key={slotKey(s)} className="flex items-center">
            {s.content}
          </span>
        ))}
      </div>
      <div className="flex min-w-0 items-center justify-center gap-2 px-3">
        {center.map((s) => (
          <span key={slotKey(s)} className="flex items-center">
            {s.content}
          </span>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
        {right.map((s) => (
          <span key={slotKey(s)} className="flex items-center">
            {s.content}
          </span>
        ))}
      </div>
    </header>
  );
}
