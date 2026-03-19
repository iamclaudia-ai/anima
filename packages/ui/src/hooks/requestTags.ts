export function mergeRequestTags(
  explicit?: string[] | null,
  defaults?: string[] | null,
): string[] | undefined {
  const merged = new Set<string>();

  for (const tag of explicit || []) {
    if (tag) merged.add(tag);
  }

  for (const tag of defaults || []) {
    if (tag) merged.add(tag);
  }

  return merged.size > 0 ? Array.from(merged) : undefined;
}
