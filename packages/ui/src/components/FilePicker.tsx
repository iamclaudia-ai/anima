import React, { useEffect, useRef } from "react";
import fuzzysort from "fuzzysort";

interface FilePickerProps {
  isOpen: boolean;
  /** Search query — text after the `@` up to the cursor. Used for the empty-state. */
  query: string;
  /**
   * Pre-filtered results — parent owns the filter so the heavy fuzzysort work
   * isn't duplicated and doesn't run when the picker is closed.
   */
  filtered: FilteredFile[];
  /** Currently highlighted index into `filtered`. */
  selectedIndex: number;
  onSelectedIndexChange(index: number): void;
  onPick(path: string): void;
}

export interface FilteredFile {
  path: string;
  matchIndices: ReadonlyArray<number>;
}

/** Cap how many results we render — keeps the picker snappy on huge repos. */
const MAX_RESULTS = 50;

/**
 * Filter and rank file paths.
 *
 * Empty query: return the first MAX_RESULTS entries unranked.
 *
 * Single-token query: standard fuzzysort. Its built-in scoring weights
 * basename + word-boundary matches more heavily, giving VS-Code-like ranking
 * out of the box (`pkg.json` ranks `package.json` ahead of
 * `packages/foo/json-utils.ts`).
 *
 * Multi-token query (split on whitespace): each token must fuzzy-match the
 * path. Final score is the sum of per-token scores; highlight indices are the
 * union of per-token matches. This is fzf's default AND-mode — `input area`
 * matches `packages/ui/src/InputArea.tsx` while letting the user chunk the
 * query for tighter narrowing.
 */
export function filterFiles(files: string[], query: string): FilteredFile[] {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return files.slice(0, MAX_RESULTS).map((path) => ({ path, matchIndices: [] }));
  }

  const targets = files.map((p) => fuzzysort.prepare(p));

  if (tokens.length === 1) {
    const results = fuzzysort.go(tokens[0], targets, { all: false, limit: MAX_RESULTS });
    return results.map((result) => ({
      path: result.target,
      matchIndices: result.indexes,
    }));
  }

  // Multi-token AND. For each token, build a path → match map (no limit so
  // the intersection isn't truncated by per-token cuts). Then keep paths that
  // matched every token, sum scores, union match indices, sort, slice.
  const tokenMaps = tokens.map((tok) => {
    const results = fuzzysort.go(tok, targets, { all: false });
    const map = new Map<string, { score: number; indexes: ReadonlyArray<number> }>();
    for (const r of results) {
      map.set(r.target, { score: r.score, indexes: r.indexes });
    }
    return map;
  });

  const ranked: Array<{ path: string; score: number; matchIndices: number[] }> = [];
  for (const path of files) {
    if (!tokenMaps.every((m) => m.has(path))) continue;
    let score = 0;
    const indices = new Set<number>();
    for (const m of tokenMaps) {
      const r = m.get(path)!;
      score += r.score;
      for (const idx of r.indexes) indices.add(idx);
    }
    ranked.push({
      path,
      score,
      matchIndices: Array.from(indices).sort((a, b) => a - b),
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, MAX_RESULTS).map(({ path, matchIndices }) => ({ path, matchIndices }));
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
  query,
  filtered,
  selectedIndex,
  onSelectedIndexChange,
  onPick,
}: FilePickerProps) {
  const listRef = useRef<HTMLUListElement>(null);

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
