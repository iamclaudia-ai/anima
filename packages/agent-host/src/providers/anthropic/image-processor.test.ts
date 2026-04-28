/**
 * Image Processor Tests
 */

import { describe, test, expect } from "bun:test";
import { processImage, processContent, type ImageBlock } from "./image-processor";
import type { ImageProcessingConfig } from "@anima/shared";

// Test config
const testConfig: ImageProcessingConfig = {
  enabled: true,
  maxWidth: 800,
  maxHeight: 800,
  maxFileSizeBytes: 500 * 1024, // 500KB
  format: "webp",
  quality: 80,
};

const disabledConfig: ImageProcessingConfig = {
  ...testConfig,
  enabled: false,
};

// Create a simple test image (1x1 red pixel PNG)
const testImageBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const testImageBlock: ImageBlock = {
  type: "image",
  source: {
    type: "base64",
    media_type: "image/png",
    data: testImageBase64,
  },
};

describe("image-processor", () => {
  test("should pass through image when processing disabled", async () => {
    const result = await processImage(testImageBlock, disabledConfig);
    expect(result.wasProcessed).toBe(false);
    expect(result.data).toBe(testImageBase64);
    expect(result.mediaType).toBe("image/png");
  });

  test("should process image when enabled", async () => {
    const result = await processImage(testImageBlock, testConfig);
    expect(result.data).toBeDefined();
    expect(result.finalSize).toBeGreaterThan(0);
  });

  test("should handle content array with text and images", async () => {
    const content = [
      { type: "text", text: "Hello world" },
      testImageBlock,
      { type: "text", text: "Another message" },
    ];

    const { content: processed, stats } = await processContent(content, testConfig);

    expect(Array.isArray(processed)).toBe(true);
    expect(stats.length).toBe(1); // One image
    expect((processed as unknown[]).length).toBe(3); // Same number of blocks
  });

  test("should handle string content without images", async () => {
    const content = "Just text, no images";
    const { content: processed, stats } = await processContent(content, testConfig);

    expect(processed).toBe(content);
    expect(stats.length).toBe(0);
  });

  test("should handle empty content array", async () => {
    const content: unknown[] = [];
    const { content: processed, stats } = await processContent(content, testConfig);

    expect(Array.isArray(processed)).toBe(true);
    expect((processed as unknown[]).length).toBe(0);
    expect(stats.length).toBe(0);
  });
});
