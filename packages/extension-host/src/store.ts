/**
 * Extension Store — persistent key-value storage for extensions.
 *
 * Each extension gets a store backed by `~/.anima/<extension-id>/store.json`.
 * Supports dot-notation for nested property access.
 *
 *   ctx.store.get("session.id")          → "abc-123"
 *   ctx.store.set("session.rotatedAt", "2026-03-21")
 *   ctx.store.get("session")             → { id: "abc-123", rotatedAt: "2026-03-21" }
 *   ctx.store.delete("session.id")
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface ExtensionStore {
  /** Get a value by key (supports dot notation for nested access) */
  get<T = unknown>(key: string): T | undefined;
  /** Set a value by key (supports dot notation for nested access). Persists immediately. */
  set(key: string, value: unknown): void;
  /** Delete a key (supports dot notation). Persists immediately. */
  delete(key: string): boolean;
  /** Get all stored data */
  all(): Record<string, unknown>;
}

/**
 * Create a persistent store for an extension.
 * Data is stored in `~/.anima/<extensionId>/store.json`.
 */
export function createExtensionStore(extensionId: string): ExtensionStore {
  const dir = join(homedir(), ".anima", extensionId);
  const filePath = join(dir, "store.json");

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Load existing data
  let data: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      data = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      // Corrupted file — start fresh
      data = {};
    }
  }

  function persist(): void {
    // Atomic write: write to tmp file then rename
    const tmpPath = filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, filePath);
  }

  function getNestedValue(obj: Record<string, unknown>, path: string[]): unknown {
    let current: unknown = obj;
    for (const key of path) {
      if (current === null || current === undefined || typeof current !== "object") {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
    let current = obj;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }
    current[path[path.length - 1]] = value;
  }

  function deleteNestedValue(obj: Record<string, unknown>, path: string[]): boolean {
    if (path.length === 1) {
      if (path[0] in obj) {
        delete obj[path[0]];
        return true;
      }
      return false;
    }

    let current = obj;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
        return false;
      }
      current = current[key] as Record<string, unknown>;
    }

    const lastKey = path[path.length - 1];
    if (lastKey in current) {
      delete current[lastKey];
      return true;
    }
    return false;
  }

  return {
    get<T = unknown>(key: string): T | undefined {
      const path = key.split(".");
      return getNestedValue(data, path) as T | undefined;
    },

    set(key: string, value: unknown): void {
      const path = key.split(".");
      setNestedValue(data, path, value);
      persist();
    },

    delete(key: string): boolean {
      const path = key.split(".");
      const deleted = deleteNestedValue(data, path);
      if (deleted) persist();
      return deleted;
    },

    all(): Record<string, unknown> {
      return structuredClone(data);
    },
  };
}
