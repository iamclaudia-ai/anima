#!/usr/bin/env node

import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("❌ Error: GEMINI_API_KEY environment variable not set");
  console.error("   Please set it in your ~/.zshrc or ~/.bashrc");
  process.exit(1);
}

async function generateCover(novelFolderPath) {
  try {
    const coverPromptPath = path.join(novelFolderPath, "cover.md");
    const outputPath = path.join(novelFolderPath, "cover.png");

    // Read the cover prompt
    if (!fs.existsSync(coverPromptPath)) {
      console.error(`❌ Error: cover.md not found at ${coverPromptPath}`);
      process.exit(1);
    }

    const coverPrompt = fs.readFileSync(coverPromptPath, "utf-8");
    const novelName = path.basename(novelFolderPath);

    console.log(`🎨 Generating cover for: ${novelName}`);
    console.log(`📝 Prompt length: ${coverPrompt.length} characters`);
    console.log(`🖼️  Aspect ratio: 2:3 (paperback book format)`);
    console.log(`📐 Resolution: 2K`);
    console.log("");

    // Initialize the Gemini API client
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    console.log("🎨 Generating image with Gemini 3 Pro Image...");

    // Generate the image
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-image-preview",
      contents: coverPrompt,
      config: {
        imageConfig: {
          aspectRatio: "2:3", // Perfect for paperback books
          imageSize: "2K", // High quality but not excessive
        },
      },
    });

    // Extract and save the image
    let imageSaved = false;
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        const imageData = part.inlineData.data;
        const buffer = Buffer.from(imageData, "base64");
        fs.writeFileSync(outputPath, buffer);
        const fileSizeKB = (buffer.length / 1024).toFixed(1);
        console.log(`✅ Cover saved: ${outputPath}`);
        console.log(`📏 File size: ${fileSizeKB} KB`);
        imageSaved = true;
      }
      if (part.text) {
        console.log(`💭 Model thoughts: ${part.text}`);
      }
    }

    if (!imageSaved) {
      console.error("❌ Error: No image data received from API");
      process.exit(1);
    }

    console.log("🎉 Cover generation complete!");
  } catch (error) {
    console.error("❌ Error generating cover:", error.message);
    if (error.response) {
      console.error("API Response:", error.response);
    }
    process.exit(1);
  }
}

// Get the novel folder path from command line arguments
const novelFolderPath = process.argv[2];

if (!novelFolderPath) {
  console.error("Usage: node generate-cover.js <novel-folder-path>");
  console.error("Example: node generate-cover.js ~/romance-novels/2026-03-01-the-art-of-falling");
  process.exit(1);
}

// Expand ~ to home directory
const expandedPath = novelFolderPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE);

if (!fs.existsSync(expandedPath)) {
  console.error(`❌ Error: Novel folder not found at ${expandedPath}`);
  process.exit(1);
}

generateCover(expandedPath);
