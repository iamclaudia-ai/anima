import React, { useEffect, useMemo, useRef } from "react";
import fuzzysort from "fuzzysort";

interface FilePickerProps {
  isOpen: boolean;
  /** Full file catalog to filter against (relative paths from cwd). */
  files: string[];
  /** Search query — text after the `@` up to the cursor. */
  query: string;
  /** Currently highlighted index into the *filtered* results. */
  selectedIndex: number;
  onSelectedIndexChange(index: number): void;
  onPick(path: string): void;
  onFilteredChange?(items: FilteredFile[]): void;
}

export interface FilteredFile {
  path: string;
  matchIndices: ReadonlyArray<number>;
}

/** Cap how many results we render — keeps the picker snappy on huge repos. */
const MAX_RESULTS = 50;

/**
 * Filter and rank file paths. Empty query returns the first MAX_RESULTS entries
 * unranked (just gives the user *something* to pick from when they first type `@`).
 */
export function filterFiles(files: string[], query: string): FilteredFile[] {
  if (query.length === 0) {
    return files.slice(0, MAX_RESULTS).map((path) => ({ path, matchIndices: [] }));
  }
  // fuzzysort weights basename and word-boundary matches more heavily, which
  // gives VS-Code-like ranking out of the box (e.g. `pkg.json` ranks
  // `package.json` ahead of `packages/foo/json-utils.ts`).
  const targets = files.map((p) => fuzzysort.prepare(p));
  const results = fuzzysort.go(query, targets, { all: false, limit: MAX_RESULTS });
  return results.map((result) => ({
    path: result.target,
    matchIndices: result.indexes,
  }));
}

function highlightPath(path: string, indices: ReadonlyArray<number>): React.ReactElement[] {
  if (indices.length === 0) return [<span key="full">{path}</span>];
  const indexSet = new Set(indices);
  const out: React.ReactElement[] = [];
  let buf = "";
  let bufHit = false;
  for (let i = 0; i < path.length; i++) {
    const isHit = indexSet.has(i);
    if (i === 0) {
      buf = path[i];
      bufHit = isHit;
      continue;
    }
    if (isHit === bufHit) {
      buf += path[i];
    } else {
      out.push(
        bufHit ? (
          <span key={`${out.length}-h`} className="text-blue-600 font-semibold">
            {buf}
          </span>
        ) : (
          <span key={`${out.length}-p`}>{buf}</span>
        ),
      );
      buf = path[i];
      bufHit = isHit;
    }
  }
  if (buf.length > 0) {
    out.push(
      bufHit ? (
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

/** Split a path into `{ dir, base }` for two-tone rendering (dir muted, base bold). */
function splitPath(path: string): { dir: string; base: string } {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return { dir: "", base: path };
  return { dir: path.slice(0, slash + 1), base: path.slice(slash + 1) };
}

export function FilePicker({
  isOpen,
  files,
  query,
  selectedIndex,
  onSelectedIndexChange,
  onPick,
  onFilteredChange,
}: FilePickerProps) {
  const filtered = useMemo(() => filterFiles(files, query), [files, query]);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    onFilteredChange?.(filtered);
  }, [filtered, onFilteredChange]);

  useEffect(() => {
    if (!isOpen) return;
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLLIElement>(`[data-file-index="${selectedIndex}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [isOpen, selectedIndex]);

  if (!isOpen) return null;

  return (
    <div
      className="absolute left-0 right-0 bottom-full mb-2 z-30 rounded-lg border border-gray-200 bg-white/95 backdrop-blur shadow-lg overflow-hidden"
      role="listbox"
      aria-label="File picker"
    >
      {filtered.length === 0 ? (
        <div className="px-3 py-2 text-sm text-gray-400">
          No files match <span className="font-mono">@{query}</span>
        </div>
      ) : (
        <ul ref={listRef} className="max-h-72 overflow-auto py-1 pl-0 m-0 list-none">
          {filtered.map((entry, idx) => {
            const isSelected = idx === selectedIndex;
            const { dir, base } = splitPath(entry.path);
            // Highlight indices apply to the full path; we just render base+dir
            // adjacent and let the highlighter span them (highlights are cosmetic).
            return (
              <li
                key={entry.path}
                data-file-index={idx}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => onSelectedIndexChange(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(entry.path);
                }}
                className={`px-3 py-2 cursor-pointer text-sm flex items-baseline gap-1 ${
                  isSelected ? "bg-blue-50" : "hover:bg-gray-50"
                }`}
              >
                <span className="font-mono text-gray-800 truncate">
                  {entry.matchIndices.length > 0 ? (
                    highlightPath(entry.path, entry.matchIndices)
                  ) : (
                    <>
                      <span className="text-gray-400">{dir}</span>
                      <span>{base}</span>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
