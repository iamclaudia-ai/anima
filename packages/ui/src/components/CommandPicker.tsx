import React, { useEffect, useMemo, useRef } from "react";
import fuzzysort from "fuzzysort";
import type { CommandItem } from "../hooks/useCommands";

interface CommandPickerProps {
  /** Whether the picker is rendered. When false, returns null. */
  isOpen: boolean;
  /** Full skill/command catalog to filter against. */
  items: CommandItem[];
  /** Search query — everything after the leading `/`. */
  query: string;
  /** Currently highlighted index into the *filtered* results. */
  selectedIndex: number;
  /** Index of the current selection — parent owns navigation state. */
  onSelectedIndexChange(index: number): void;
  /** Fired when the user picks an entry (Tab/Enter/Space/click). */
  onPick(item: CommandItem): void;
  /** Filtered results — exposed up so parent can compute selectedIndex bounds. */
  onFilteredChange?(items: FilteredItem[]): void;
}

export interface FilteredItem {
  item: CommandItem;
  /** Highlight indices into `item.name` returned by fuzzysort. */
  matchIndices: ReadonlyArray<number>;
}

/**
 * Run the fuzzy matcher and return scored, sorted results. Empty query → return
 * everything in alpha order with no highlights.
 */
export function filterCommands(items: CommandItem[], query: string): FilteredItem[] {
  if (query.length === 0) {
    return items.map((item) => ({ item, matchIndices: [] }));
  }
  const targets = items.map((item) => fuzzysort.prepare(item.name));
  const results = fuzzysort.go(query, targets, { all: false });
  return results.map((result) => {
    const name = result.target;
    return {
      item: items.find((i) => i.name === name)!,
      matchIndices: result.indexes,
    };
  });
}

function highlight(name: string, indices: ReadonlyArray<number>): React.ReactElement[] {
  if (indices.length === 0) return [<span key="full">{name}</span>];
  const indexSet = new Set(indices);
  const out: React.ReactElement[] = [];
  let buf = "";
  let bufHighlighted = false;
  for (let i = 0; i < name.length; i++) {
    const isHit = indexSet.has(i);
    if (i === 0) {
      buf = name[i];
      bufHighlighted = isHit;
      continue;
    }
    if (isHit === bufHighlighted) {
      buf += name[i];
    } else {
      out.push(
        bufHighlighted ? (
          <span key={`${out.length}-h`} className="text-blue-600 font-semibold">
            {buf}
          </span>
        ) : (
          <span key={`${out.length}-p`}>{buf}</span>
        ),
      );
      buf = name[i];
      bufHighlighted = isHit;
    }
  }
  if (buf.length > 0) {
    out.push(
      bufHighlighted ? (
        <span key={`${out.length}-h`} className="text-blue-600 font-semibold">
          {buf}
        </span>
      ) : (
        <span key={`${out.length}-p`}>{buf}</span>
      ),
    );
  }
  return out;
}

export function CommandPicker({
  isOpen,
  items,
  query,
  selectedIndex,
  onSelectedIndexChange,
  onPick,
  onFilteredChange,
}: CommandPickerProps) {
  const filtered = useMemo(() => filterCommands(items, query), [items, query]);
  const listRef = useRef<HTMLUListElement>(null);

  // Notify parent whenever filtered list changes (so it can clamp selectedIndex).
  useEffect(() => {
    onFilteredChange?.(filtered);
  }, [filtered, onFilteredChange]);

  // Auto-scroll the highlighted item into view.
  useEffect(() => {
    if (!isOpen) return;
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLLIElement>(`[data-cmd-index="${selectedIndex}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [isOpen, selectedIndex]);

  if (!isOpen) return null;

  return (
    <div
      className="absolute left-0 right-0 bottom-full mb-2 z-30 rounded-lg border border-gray-200 bg-white/95 backdrop-blur shadow-lg overflow-hidden"
      role="listbox"
      aria-label="Skill and command picker"
    >
      {filtered.length === 0 ? (
        <div className="px-3 py-2 text-sm text-gray-400">
          No matches for <span className="font-mono">/{query}</span>
        </div>
      ) : (
        <ul ref={listRef} className="max-h-72 overflow-auto py-1 pl-0 m-0 list-none">
          {filtered.map((entry, idx) => {
            const isSelected = idx === selectedIndex;
            return (
              <li
                key={entry.item.name}
                data-cmd-index={idx}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => onSelectedIndexChange(idx)}
                onMouseDown={(e) => {
                  // Use mousedown so the textarea doesn't blur before we pick.
                  e.preventDefault();
                  onPick(entry.item);
                }}
                className={`px-3 py-2 cursor-pointer text-sm flex items-baseline gap-2 ${
                  isSelected ? "bg-blue-50" : "hover:bg-gray-50"
                }`}
              >
                <span className="font-mono text-gray-800">
                  /{highlight(entry.item.name, entry.matchIndices)}
                </span>
                {entry.item.description && (
                  <span className="text-gray-500 text-xs truncate flex-1 min-w-0">
                    {entry.item.description}
                  </span>
                )}
                {entry.item.source === "project" && (
                  <span className="text-[10px] uppercase tracking-wide text-emerald-600 font-semibold flex-shrink-0">
                    project
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
