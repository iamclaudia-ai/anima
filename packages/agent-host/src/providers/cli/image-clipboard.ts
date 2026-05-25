/**
 * macOS clipboard image paste for the Claude CLI runtime (#33).
 *
 * The claude TUI ingests images via Ctrl-V, which reads the system pasteboard.
 * We decode an inbound base64 image, normalize it to PNG (`sips` handles any
 * source format), and load it onto the pasteboard as «class PNGf» — macOS then
 * derives every other representation automatically. The caller sends Ctrl-V via
 * tmux so the TUI picks it up (verified: the pane shows `[Image #N]`).
 *
 * macOS-only (osascript + sips); returns false on other platforms or any error
 * so the caller can skip the attachment without aborting the prompt.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Decode a base64 image and place it on the macOS clipboard. */
export function copyImageToClipboard(base64: string, mediaType: string): boolean {
  if (process.platform !== "darwin") return false;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "anima-img-"));
    const ext =
      (mediaType.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
    const srcPath = join(dir, `img.${ext}`);
    writeFileSync(srcPath, Buffer.from(base64, "base64"));

    // Normalize to PNG unless already PNG; macOS derives the other formats.
    let pngPath = srcPath;
    if (ext !== "png") {
      pngPath = join(dir, "img.png");
      execFileSync("sips", ["-s", "format", "png", srcPath, "--out", pngPath], { stdio: "ignore" });
    }

    // `read … as «class PNGf»` copies the bytes into the pasteboard, so the temp
    // file is safe to delete immediately after.
    execFileSync("osascript", [
      "-e",
      `set the clipboard to (read (POSIX file ${JSON.stringify(pngPath)}) as «class PNGf»)`,
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
