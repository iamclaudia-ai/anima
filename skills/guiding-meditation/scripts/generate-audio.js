#!/usr/bin/env node

/**
 * ElevenLabs Text-to-Dialogue Generator for Meditation Sessions
 *
 * Uses the ElevenLabs text-to-dialogue API with eleven_v3 model
 * to generate high-quality emotional audio from meditation markdown.
 *
 * Supports automatic chunking for long meditations (>3000 chars)
 * with ffmpeg merging and silence padding between chunks.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// ElevenLabs eleven_v3 model has a 3000 character limit
const MAX_CHUNK_SIZE = 2900; // Leave buffer for safety
const SILENCE_BETWEEN_CHUNKS = 0.8; // seconds

if (!API_KEY || !VOICE_ID) {
  console.error(
    "❌ Error: ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID environment variables are required",
  );
  console.error("   Get your API key from: https://elevenlabs.io/app/speech-synthesis");
  process.exit(1);
}

/**
 * Split text into chunks at natural boundaries (paragraphs)
 * @param {string} text - Text to split
 * @param {number} maxSize - Maximum chunk size
 * @returns {string[]} Array of text chunks
 */
function splitIntoChunks(text, maxSize = MAX_CHUNK_SIZE) {
  if (text.length <= maxSize) {
    return [text];
  }

  const chunks = [];
  const paragraphs = text.split("\n\n");
  let currentChunk = "";

  for (const paragraph of paragraphs) {
    // If single paragraph exceeds max size, we have to split it
    if (paragraph.length > maxSize) {
      // Save current chunk if it has content
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }

      // Split long paragraph by sentences
      const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length + 1 > maxSize) {
          if (currentChunk.trim()) {
            chunks.push(currentChunk.trim());
          }
          currentChunk = sentence;
        } else {
          currentChunk += (currentChunk ? " " : "") + sentence;
        }
      }
      continue;
    }

    // Check if adding this paragraph would exceed limit
    const testChunk = currentChunk ? currentChunk + "\n\n" + paragraph : paragraph;
    if (testChunk.length > maxSize) {
      // Save current chunk and start new one
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = paragraph;
    } else {
      currentChunk = testChunk;
    }
  }

  // Add final chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Generate audio for a single text chunk
 * @param {string} text - Text to convert to speech
 * @param {string} outputPath - Path to save MP3 file
 * @returns {Promise<number>} Size of generated audio in bytes
 */
async function generateChunkAudio(text, outputPath) {
  const response = await fetch("https://api.elevenlabs.io/v1/text-to-dialogue", {
    method: "POST",
    headers: {
      Accept: "audio/mpeg",
      "Content-Type": "application/json",
      "xi-api-key": API_KEY,
    },
    body: JSON.stringify({
      inputs: [
        {
          text: text,
          voice_id: VOICE_ID,
        },
      ],
      model_id: "eleven_v3", // Use v3 for audio tags support
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
  }

  const audioBuffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(audioBuffer));

  return audioBuffer.byteLength;
}

/**
 * Merge multiple audio files with silence between them using ffmpeg
 * @param {string[]} partPaths - Paths to part files
 * @param {string} outputPath - Path to save merged file
 */
function mergeAudioParts(partPaths, outputPath) {
  console.log(
    `🔗 Merging ${partPaths.length} audio parts with ${SILENCE_BETWEEN_CHUNKS}s silence...`,
  );

  const tempDir = path.dirname(partPaths[0]);
  const concatListPath = path.join(tempDir, "concat-list.txt");

  // Create ffmpeg concat file with silence padding between parts
  const concatList = partPaths
    .map((partPath, i) => {
      // For each part except the last, add the part then silence
      if (i < partPaths.length - 1) {
        return `file '${path.basename(partPath)}'\nfile 'silence.mp3'`;
      }
      return `file '${path.basename(partPath)}'`;
    })
    .join("\n");

  fs.writeFileSync(concatListPath, concatList);

  // Generate silence.mp3 using ffmpeg
  const silencePath = path.join(tempDir, "silence.mp3");
  execSync(
    `ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t ${SILENCE_BETWEEN_CHUNKS} -q:a 9 -acodec libmp3lame "${silencePath}" -y`,
    { stdio: "pipe" },
  );

  // Concatenate all parts (re-encode for seamless playback)
  execSync(
    `ffmpeg -f concat -safe 0 -i "${concatListPath}" -c:a libmp3lame -q:a 2 "${outputPath}" -y`,
    { stdio: "pipe" },
  );

  // Clean up temporary files (but keep parts for verification)
  fs.unlinkSync(concatListPath);
  fs.unlinkSync(silencePath);
  // partPaths are kept for verification - delete manually if merge is good

  console.log("✅ Audio parts merged successfully!");
  console.log("📦 Part files kept for verification - delete manually if merge sounds good");
}

/**
 * Generate audio from meditation markdown file
 * @param {string} markdownPath - Path to the markdown file
 * @returns {Promise<string>} Path to generated MP3 file
 */
async function generateAudio(markdownPath) {
  try {
    console.log(`🧘 Generating meditation audio for: ${path.basename(markdownPath)}`);

    // Read markdown file
    if (!fs.existsSync(markdownPath)) {
      throw new Error(`Markdown file not found: ${markdownPath}`);
    }

    const markdownContent = fs.readFileSync(markdownPath, "utf8");

    // Extract meditation content between the --- markers, excluding header/metadata
    let meditationText = markdownContent;

    // Remove title and description
    meditationText = meditationText.replace(/^# .*$/gm, "");
    meditationText = meditationText.replace(/^\*.*\*$/gm, "");

    // Extract content between --- markers
    const betweenDashes = meditationText.match(/---\n\n([\s\S]*?)\n\n---/);
    if (betweenDashes) {
      meditationText = betweenDashes[1];
    } else {
      // Fallback: remove everything after second ---
      meditationText = meditationText.replace(/\n\n---\n\n[\s\S]*$/, "");
      meditationText = meditationText.replace(/^---\n\n/, "");
    }

    meditationText = meditationText.trim();

    if (!meditationText) {
      throw new Error("No meditation content found in markdown file");
    }

    console.log(`📝 Meditation length: ${meditationText.length} characters`);
    console.log(`🎵 Using voice: ${VOICE_ID}`);

    // Split into chunks if needed
    const chunks = splitIntoChunks(meditationText);

    if (chunks.length > 1) {
      console.log(`📦 Split into ${chunks.length} chunks for processing`);
    }

    const audioPath = markdownPath.replace(/\.md$/, ".mp3");
    const tempDir = path.dirname(audioPath);

    // Generate audio for each chunk
    const partPaths = [];
    let totalSize = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const partNum = i + 1;
      console.log(`🎙️  Generating part ${partNum}/${chunks.length} (${chunk.length} chars)...`);

      const partPath = path.join(tempDir, `${path.basename(audioPath, ".mp3")}-part${partNum}.mp3`);

      const size = await generateChunkAudio(chunk, partPath);
      totalSize += size;
      partPaths.push(partPath);

      console.log(`✅ Part ${partNum} generated (${(size / 1024).toFixed(1)} KB)`);
    }

    // Merge parts if multiple chunks, otherwise just rename single part
    if (chunks.length > 1) {
      mergeAudioParts(partPaths, audioPath);
    } else {
      // Single chunk - just rename to final path
      fs.renameSync(partPaths[0], audioPath);
    }

    const sizeKB = (totalSize / 1024).toFixed(1);
    const estimatedCredits = Math.ceil(meditationText.length / 1000);

    console.log(`💾 Audio saved: ${path.basename(audioPath)}`);
    console.log(`📏 File size: ${sizeKB} KB`);
    console.log(`💳 Estimated credits used: ${estimatedCredits}`);

    return audioPath;
  } catch (error) {
    console.error(`❌ Error generating meditation audio: ${error.message}`);
    throw error;
  }
}

// Command line usage
async function main() {
  const markdownPath = process.argv[2];

  if (!markdownPath) {
    console.error("Usage: node generate-audio.js <path-to-markdown-file>");
    process.exit(1);
  }

  try {
    await generateAudio(markdownPath);
    console.log("🎉 Meditation audio generation complete!");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

// Export for use in skill
module.exports = { generateAudio };

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}
