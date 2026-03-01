export function joinWorkspacePath(basePath: string, segment: string): string {
  const trimmedSegment = segment.replace(/^\/+|\/+$/g, "");
  if (!trimmedSegment) return basePath;

  if (basePath === "~") return `~/${trimmedSegment}`;
  if (basePath === "/") return `/${trimmedSegment}`;

  const normalizedBase =
    basePath.length > 1 && basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return `${normalizedBase}/${trimmedSegment}`;
}

export function getWorkspaceParentPath(path: string): string {
  const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (!normalized || normalized === "~" || normalized === "/") return normalized || "/";

  if (normalized.startsWith("~/")) {
    const parts = normalized.slice(2).split("/").filter(Boolean);
    if (parts.length <= 1) return "~";
    parts.pop();
    return `~/${parts.join("/")}`;
  }

  const isAbsolute = normalized.startsWith("/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return isAbsolute ? "/" : parts[0] || ".";
  parts.pop();
  return isAbsolute ? `/${parts.join("/")}` : parts.join("/");
}

export function buildWorkspacePath(basePath: string, newFolderName: string): string {
  const trimmedFolderName = newFolderName.trim();
  if (!trimmedFolderName) return basePath;
  return joinWorkspacePath(basePath, trimmedFolderName);
}
