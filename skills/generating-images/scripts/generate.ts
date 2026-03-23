#!/usr/bin/env bun

function printUsage() {
  console.log("Usage: nano-banana-generate <prompt> <output-path> [options]");
  console.log("");
  console.log("Arguments:");
  console.log("  <prompt>        Text description of the image (quoted)");
  console.log("  <output-path>   Where to save the PNG file");
  console.log("");
  console.log("Options:");
  console.log("  --aspect-ratio  Aspect ratio (default: 1:1)");
  console.log("                  Options: 1:1, 16:9, 9:16, 4:3, 3:4, 2:3, 3:2");
  console.log("  --size          Resolution (default: 2K)");
  console.log("                  Options: 1K, 2K, 4K");
  console.log("");
  console.log("Examples:");
  console.log('  nano-banana-generate "sunset over ocean" ~/sunset.png');
  console.log('  nano-banana-generate "city skyline" ~/city.png --aspect-ratio 16:9 --size 4K');
  console.log('  nano-banana-generate "portrait" ~/face.png --aspect-ratio 2:3');
}

async function generateImage(prompt, outputPath, aspectRatio = "1:1", imageSize = "2K") {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    if (!GEMINI_API_KEY) {
      console.error("❌ Error: GEMINI_API_KEY environment variable not set");
      console.error("   Please set it in your ~/.zshrc or ~/.bashrc");
      process.exit(1);
    }

    console.log(`🍌 Generating image with Gemini nano-banana-pro...`);
    console.log(`📝 Prompt: ${prompt}`);
    console.log(`📐 Aspect ratio: ${aspectRatio}`);
    console.log(`🖼️  Resolution: ${imageSize}`);
    console.log("");

    // Call Gemini API directly
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            imageConfig: {
              aspectRatio: aspectRatio,
              imageSize: imageSize,
            },
          },
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }

    const result = await response.json();

    // Extract and save the image
    let imageSaved = false;
    for (const candidate of result.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        if (part.inlineData) {
          const imageData = part.inlineData.data;
          const buffer = Buffer.from(imageData, "base64");

          // Expand ~ to home directory
          const expandedPath = outputPath.replace(
            /^~/,
            process.env.HOME || process.env.USERPROFILE,
          );

          // Ensure directory exists
          const fs = await import("fs");
          const path = await import("path");
          const dir = path.dirname(expandedPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }

          fs.writeFileSync(expandedPath, buffer);
          const fileSizeKB = (buffer.length / 1024).toFixed(1);
          console.log(`✅ Image saved: ${expandedPath}`);
          console.log(`📏 File size: ${fileSizeKB} KB`);
          imageSaved = true;
        }
        if (part.text) {
          console.log(`💭 Model notes: ${part.text}`);
        }
      }
    }

    if (!imageSaved) {
      console.error("❌ Error: No image data received from API");
      process.exit(1);
    }

    console.log("🎉 Image generation complete!");
  } catch (error) {
    console.error("❌ Error generating image:", error.message);
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 2 || args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

const prompt = args[0];
const outputPath = args[1];

// Parse optional arguments
let aspectRatio = "1:1";
let imageSize = "2K";

for (let i = 2; i < args.length; i++) {
  if (args[i] === "--aspect-ratio" && args[i + 1]) {
    aspectRatio = args[i + 1];
    i++;
  } else if (args[i] === "--size" && args[i + 1]) {
    imageSize = args[i + 1];
    i++;
  }
}

// Validate aspect ratio
const validAspectRatios = ["1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2"];
if (!validAspectRatios.includes(aspectRatio)) {
  console.error(`❌ Error: Invalid aspect ratio "${aspectRatio}"`);
  console.error(`   Valid options: ${validAspectRatios.join(", ")}`);
  process.exit(1);
}

// Validate image size
const validSizes = ["1K", "2K", "4K"];
if (!validSizes.includes(imageSize)) {
  console.error(`❌ Error: Invalid image size "${imageSize}"`);
  console.error(`   Valid options: ${validSizes.join(", ")}`);
  process.exit(1);
}

generateImage(prompt, outputPath, aspectRatio, imageSize);
