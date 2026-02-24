/**
 * Image Processor
 *
 * Validates and processes images before sending to the Claude API:
 * - Resizes oversized images to recommended dimensions (~1.15 MP)
 * - Compresses to target file size (<1MB)
 * - Converts to optimal format (WebP for screenshots, JPEG fallback)
 *
 * Prevents API errors from 5MB image size limits and improves performance
 * by following Anthropic's recommendations.
 */

import sharp from "sharp";
import type { ImageProcessingConfig } from "@claudia/shared";
import { createLogger } from "@claudia/shared";
import { join } from "node:path";
import { homedir } from "node:os";

const log = createLogger("ImageProcessor", join(homedir(), ".claudia", "logs", "session.log"));

// ── Types ────────────────────────────────────────────────────

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface ProcessingResult {
  /** Processed base64 data (without data URI prefix) */
  data: string;
  /** Output media type (e.g., "image/webp") */
  mediaType: string;
  /** Whether the image was modified */
  wasProcessed: boolean;
  /** Original file size in bytes */
  originalSize: number;
  /** Final file size in bytes */
  finalSize: number;
  /** Original dimensions */
  originalDimensions: { width: number; height: number };
  /** Final dimensions */
  finalDimensions: { width: number; height: number };
}

// ── Utilities ───────────────────────────────────────────────

/**
 * Calculate dimensions that maintain aspect ratio while fitting within max bounds
 */
function calculateTargetDimensions(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const aspectRatio = width / height;

  let targetWidth = width;
  let targetHeight = height;

  // Scale down if width exceeds max
  if (targetWidth > maxWidth) {
    targetWidth = maxWidth;
    targetHeight = Math.round(targetWidth / aspectRatio);
  }

  // Scale down if height still exceeds max
  if (targetHeight > maxHeight) {
    targetHeight = maxHeight;
    targetWidth = Math.round(targetHeight * aspectRatio);
  }

  return { width: targetWidth, height: targetHeight };
}

/**
 * Get media type string for format
 */
function getMediaType(format: "webp" | "jpeg" | "png"): string {
  switch (format) {
    case "webp":
      return "image/webp";
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
  }
}

// ── Main Processing ─────────────────────────────────────────

/**
 * Process an image block according to config settings.
 * Returns processed image data or original if no processing needed.
 */
export async function processImage(
  imageBlock: ImageBlock,
  config: ImageProcessingConfig,
): Promise<ProcessingResult> {
  if (!config.enabled) {
    // Processing disabled — return original
    const originalBuffer = Buffer.from(imageBlock.source.data, "base64");
    const metadata = await sharp(originalBuffer).metadata();
    return {
      data: imageBlock.source.data,
      mediaType: imageBlock.source.media_type,
      wasProcessed: false,
      originalSize: originalBuffer.length,
      finalSize: originalBuffer.length,
      originalDimensions: { width: metadata.width || 0, height: metadata.height || 0 },
      finalDimensions: { width: metadata.width || 0, height: metadata.height || 0 },
    };
  }

  try {
    const originalBuffer = Buffer.from(imageBlock.source.data, "base64");
    const originalSize = originalBuffer.length;

    // Get metadata
    const metadata = await sharp(originalBuffer).metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;

    log.info("Processing image", {
      originalSize: `${(originalSize / 1024 / 1024).toFixed(2)} MB`,
      dimensions: `${width}×${height}`,
      format: metadata.format,
    });

    // Check if processing is needed
    const needsResize = width > config.maxWidth || height > config.maxHeight;
    const needsCompress = originalSize > config.maxFileSizeBytes;

    if (!needsResize && !needsCompress) {
      log.info("Image already optimal, skipping processing");
      return {
        data: imageBlock.source.data,
        mediaType: imageBlock.source.media_type,
        wasProcessed: false,
        originalSize,
        finalSize: originalSize,
        originalDimensions: { width, height },
        finalDimensions: { width, height },
      };
    }

    // Calculate target dimensions
    const targetDims = calculateTargetDimensions(width, height, config.maxWidth, config.maxHeight);

    log.info("Resizing image", {
      from: `${width}×${height}`,
      to: `${targetDims.width}×${targetDims.height}`,
      targetFormat: config.format,
    });

    // Process image
    let pipeline = sharp(originalBuffer).resize(targetDims.width, targetDims.height, {
      fit: "inside",
      withoutEnlargement: true,
    });

    // Apply format-specific compression
    switch (config.format) {
      case "webp":
        pipeline = pipeline.webp({ quality: config.quality });
        break;
      case "jpeg":
        pipeline = pipeline.jpeg({ quality: config.quality, mozjpeg: true });
        break;
      case "png":
        pipeline = pipeline.png({ quality: config.quality, compressionLevel: 9 });
        break;
    }

    const processedBuffer = await pipeline.toBuffer();
    const finalSize = processedBuffer.length;
    const finalData = processedBuffer.toString("base64");
    const finalMediaType = getMediaType(config.format);

    const reduction = ((1 - finalSize / originalSize) * 100).toFixed(1);
    log.info("Image processing complete", {
      originalSize: `${(originalSize / 1024 / 1024).toFixed(2)} MB`,
      finalSize: `${(finalSize / 1024 / 1024).toFixed(2)} MB`,
      reduction: `${reduction}%`,
      finalDimensions: `${targetDims.width}×${targetDims.height}`,
    });

    return {
      data: finalData,
      mediaType: finalMediaType,
      wasProcessed: true,
      originalSize,
      finalSize,
      originalDimensions: { width, height },
      finalDimensions: targetDims,
    };
  } catch (error) {
    log.error("Image processing failed, using original", {
      error: error instanceof Error ? error.message : String(error),
    });

    // Return original on error
    const originalBuffer = Buffer.from(imageBlock.source.data, "base64");
    return {
      data: imageBlock.source.data,
      mediaType: imageBlock.source.media_type,
      wasProcessed: false,
      originalSize: originalBuffer.length,
      finalSize: originalBuffer.length,
      originalDimensions: { width: 0, height: 0 },
      finalDimensions: { width: 0, height: 0 },
    };
  }
}

/**
 * Process all image blocks in content array.
 * Returns new content array with processed images and processing stats.
 */
export async function processContent(
  content: string | unknown[],
  config: ImageProcessingConfig,
): Promise<{
  content: string | unknown[];
  stats: ProcessingResult[];
}> {
  // String content has no images
  if (typeof content === "string") {
    return { content, stats: [] };
  }

  const stats: ProcessingResult[] = [];
  const processedContent: unknown[] = [];

  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "image" &&
      "source" in block
    ) {
      // Process image block
      const imageBlock = block as ImageBlock;
      const result = await processImage(imageBlock, config);
      stats.push(result);

      // Replace with processed version
      processedContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: result.mediaType,
          data: result.data,
        },
      });
    } else {
      // Pass through non-image blocks
      processedContent.push(block);
    }
  }

  return { content: processedContent, stats };
}
