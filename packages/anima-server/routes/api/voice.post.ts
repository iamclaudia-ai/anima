import { defineEventHandler, readBody, getHeader } from "h3";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfig } from "../../config";

interface VoiceUploadRequest {
  content: string;
}

export default defineEventHandler(async (event) => {
  try {
    // Validate API key
    const config = getConfig();
    if (config.apiKey) {
      const authHeader = getHeader(event, "authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return {
          success: false,
          error: "Unauthorized: Missing or invalid authorization header",
        };
      }

      const token = authHeader.slice(7); // Remove "Bearer " prefix
      if (token !== config.apiKey) {
        return {
          success: false,
          error: "Unauthorized: Invalid API key",
        };
      }
    }

    // Read the journal content from the request
    const body = await readBody<VoiceUploadRequest>(event);

    if (!body || !body.content) {
      return {
        success: false,
        error: "No content provided",
      };
    }

    const { content } = body;
    const basePath = config.voice.journalPath;

    // Generate timestamp and path
    const timestamp = new Date();
    const entryPath = getEntryPath(basePath, timestamp);

    // Ensure directory exists
    await fs.mkdir(path.dirname(entryPath), { recursive: true });

    // Write the journal entry
    await fs.writeFile(entryPath, content, "utf-8");

    return {
      success: true,
      timestamp: timestamp.toISOString(),
      filePath: entryPath,
    };
  } catch (error) {
    console.error("Error writing journal entry:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
});

function getEntryPath(basePath: string, timestamp: Date): string {
  // Format: YYYY-MM-DD/HH-MM-SS-MMMZ.md
  const date = timestamp.toISOString().split("T")[0];
  const time = timestamp.toISOString().split("T")[1];
  const [hours, minutes, seconds] = time.split(":");
  const [secs, ms] = seconds.split(".");
  const milliseconds = ms.slice(0, 3); // Get first 3 digits for milliseconds
  const filename = `${hours}-${minutes}-${secs}-${milliseconds}Z.md`;

  return path.join(basePath, date, filename);
}
