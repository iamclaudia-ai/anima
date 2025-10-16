import { defineEventHandler, readBody, getHeader } from "h3";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfig } from "../../config";

interface VisionGenerateRequest {
  prompt: string;
  negative_prompt?: string;
  aspect_ratio?: string;
  seed?: number;
  output_format?: "png" | "jpeg" | "webp";
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

      const token = authHeader.slice(7);
      if (token !== config.apiKey) {
        return {
          success: false,
          error: "Unauthorized: Invalid API key",
        };
      }
    }

    // Read the image generation request
    const body = await readBody<VisionGenerateRequest>(event);

    if (!body || !body.prompt) {
      return {
        success: false,
        error: "No prompt provided",
      };
    }

    const { prompt, negative_prompt, aspect_ratio, seed, output_format } = body;
    const format = output_format || "png";

    // Call Stability AI API
    const response = await fetch(
      "https://api.stability.ai/v2beta/stable-image/generate/core",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.vision.stabilityApiKey}`,
          Accept: "image/*",
        },
        body: buildFormData({
          prompt,
          negative_prompt,
          aspect_ratio,
          seed,
          output_format: format,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Stability AI API error: ${response.status} - ${errorText}`,
      };
    }

    // Get image buffer
    const imageBuffer = await response.arrayBuffer();

    // Generate timestamp and paths
    const timestamp = new Date();
    const imagePath = getImagePath(config.vision.imagePath, timestamp, format);
    const metadataPath = imagePath.replace(`.${format}`, ".json");

    // Ensure directory exists
    await fs.mkdir(path.dirname(imagePath), { recursive: true });

    // Write image
    await fs.writeFile(imagePath, Buffer.from(imageBuffer));

    // Write metadata
    const metadata = {
      prompt,
      negativePrompt: negative_prompt,
      seed,
      timestamp: timestamp.toISOString(),
      backend: "stability-ai",
      aspectRatio: aspect_ratio,
      outputFormat: format,
    };
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    return {
      success: true,
      imagePath,
      timestamp: timestamp.toISOString(),
      metadata: {
        prompt,
        seed,
        backend: "stability-ai",
      },
    };
  } catch (error) {
    console.error("Error generating image:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
});

function buildFormData(request: {
  prompt: string;
  negative_prompt?: string;
  aspect_ratio?: string;
  seed?: number;
  output_format?: string;
}): FormData {
  const formData = new FormData();

  formData.append("prompt", request.prompt);

  if (request.negative_prompt) {
    formData.append("negative_prompt", request.negative_prompt);
  }

  if (request.aspect_ratio) {
    formData.append("aspect_ratio", request.aspect_ratio);
  }

  if (request.seed !== undefined) {
    formData.append("seed", request.seed.toString());
  }

  formData.append("output_format", request.output_format || "png");

  return formData;
}

function getImagePath(
  basePath: string,
  timestamp: Date,
  format: string
): string {
  // Format: YYYY-MM-DD/HH-MM-SS-MMMZ.{format}
  const date = timestamp.toISOString().split("T")[0];
  const time = timestamp.toISOString().split("T")[1];
  const [hours, minutes, seconds] = time.split(":");
  const [secs, ms] = seconds.split(".");
  const milliseconds = ms.slice(0, 3);
  const filename = `${hours}-${minutes}-${secs}-${milliseconds}Z.${format}`;

  return path.join(basePath, date, filename);
}
