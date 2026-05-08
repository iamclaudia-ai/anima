#!/usr/bin/env node

/**
 * eleven-tts — ElevenLabs Text-to-Dialogue CLI
 *
 * Converts a markdown source file to MP3 audio using the ElevenLabs
 * text-to-dialogue API with the eleven_v3 model. The output MP3 is
 * written next to the input markdown (chapter-1.md → chapter-1.mp3).
 *
 * Used as a shared tool by skills that need TTS output (writing-romance-novels,
 * guiding-meditation, creating-bedtime-stories). The skill runner exposes it
 * to skills via skill.json's `command` field, but it can also be invoked
 * directly as `eleven-tts <path>` from any shell.
 *
 * Features:
 *   - Auto-chunks long inputs at the eleven_v3 3000-char limit
 *   - Persists each chunk to <basename>-partN.md so re-runs after a partial
 *     failure (or input edit) regenerate only the changed or missing parts
 *   - Merges chunks with ffmpeg (re-encoded for seamless playback) plus
 *     a short silence between chunks
 *   - Detects meditation vs prose markdown formats and strips headings
 *     accordingly while preserving emotion tags
 *   - Reports progress via $ANIMA_TASK_ID + `anima scheduler update_progress`
 *     when run under the skill runner's --task mode (no-op otherwise)
 *
 * Required env vars:
 *   ELEVENLABS_API_KEY
 *   ELEVENLABS_VOICE_ID
 *
 * Usage:
 *   eleven-tts <path-to-markdown-file>
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

const API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

/**
 * Report progress to the scheduler when running under `anima skill run --task`.
 * No-op in synchronous mode (ANIMA_TASK_ID not set).
 *
 * The scheduler stores the latest message on the running execution row, and
 * `anima skill task <id>` surfaces it. Failures here are silent — progress
 * reporting is best-effort.
 */
function progress(message) {
  if (!process.env.ANIMA_TASK_ID) return;
  try {
    spawnSync(
      "anima",
      ["scheduler", "update_progress", "--taskId", process.env.ANIMA_TASK_ID, "--message", message],
      { stdio: "ignore", timeout: 5000 },
    );
  } catch {
    // Silently swallow — never let progress reporting break the script.
  }
}

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
  console.log("📦 Part files kept for resume support — delete manually to force full regeneration");
}

/**
 * Generate audio from a markdown file.
 * Output MP3 is written alongside the input (foo.md → foo.mp3).
 *
 * Detects two markdown shapes:
 *   - Meditation-style: content sandwiched between `---` blocks (frontmatter
 *     and trailing metadata get stripped)
 *   - Prose: # / ## headings stripped, body preserved (section break `---`
 *     sequences pass through as natural pauses for the TTS)
 *
 * @param {string} markdownPath - Absolute path to the input markdown file
 * @returns {Promise<string>} Path to generated MP3 file
 */
async function generateAudio(markdownPath) {
  try {
    console.log(`🎙️  Generating audio for: ${path.basename(markdownPath)}`);

    // Read markdown file
    if (!fs.existsSync(markdownPath)) {
      throw new Error(`Markdown file not found: ${markdownPath}`);
    }

    const markdownContent = fs.readFileSync(markdownPath, "utf8");

    // Strip headings/frontmatter according to detected shape
    let bodyText = markdownContent;
    const hasFrontmatter = bodyText.trim().startsWith("---");

    if (hasFrontmatter) {
      // Meditation-style: extract content between leading and trailing --- markers
      bodyText = bodyText.replace(/^# .*$/gm, "");
      bodyText = bodyText.replace(/^\*.*\*$/gm, "");

      const betweenDashes = bodyText.match(/---\n\n([\s\S]*?)\n\n---/);
      if (betweenDashes) {
        bodyText = betweenDashes[1];
      } else {
        bodyText = bodyText.replace(/\n\n---\n\n[\s\S]*$/, "");
        bodyText = bodyText.replace(/^---\n\n/, "");
      }
    } else {
      // Prose: strip h1/h2 headings, leave body (including section break `---`) intact
      bodyText = bodyText.replace(/^# .*$/gm, "");
      bodyText = bodyText.replace(/^## .*$/gm, "");
    }

    bodyText = bodyText.trim();

    if (!bodyText) {
      throw new Error("No content found in markdown file after stripping headings");
    }

    console.log(`📝 Source length: ${bodyText.length} characters`);
    console.log(`🎵 Using voice: ${VOICE_ID}`);

    // Split into chunks if needed
    const chunks = splitIntoChunks(bodyText);

    if (chunks.length > 1) {
      console.log(`📦 Split into ${chunks.length} chunks for processing`);
    }

    const audioPath = markdownPath.replace(/\.md$/, ".mp3");
    const tempDir = path.dirname(audioPath);

    // Generate audio for each chunk, with resume support:
    //   - Persist each chunk's text to <basename>-partN.md before generating
    //     audio. A partial failure leaves the chunk MD on disk so a rerun
    //     knows what was attempted.
    //   - On rerun, if partN.md content matches the current chunk text AND
    //     partN.mp3 exists, skip generation. If only the audio is missing,
    //     re-generate just the audio (don't rewrite the MD). If the chunk
    //     text changed, overwrite both MD and audio.
    //   - Stale part files (beyond chunks.length) are pruned after the loop.
    const partPaths = [];
    let totalSize = 0;
    let regenerated = 0;
    let skipped = 0;
    let regeneratedCharCount = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const partNum = i + 1;
      const partBase = `${path.basename(audioPath, ".mp3")}-part${partNum}`;
      const partMdPath = path.join(tempDir, `${partBase}.md`);
      const partMp3Path = path.join(tempDir, `${partBase}.mp3`);

      const mdExisted = fs.existsSync(partMdPath);
      const mdMatches = mdExisted && fs.readFileSync(partMdPath, "utf8") === chunk;
      const mp3Exists = fs.existsSync(partMp3Path);

      if (mdMatches && mp3Exists) {
        // Cached: chunk text unchanged and audio already on disk.
        const size = fs.statSync(partMp3Path).size;
        totalSize += size;
        partPaths.push(partMp3Path);
        skipped++;
        console.log(
          `⏭️  Part ${partNum}/${chunks.length} unchanged, skipping (${(size / 1024).toFixed(1)} KB)`,
        );
        progress(`Skipping part ${partNum} of ${chunks.length} (cached)`);
        continue;
      }

      // Persist chunk text first so a partial failure leaves enough state
      // for a future rerun to resume from the right place.
      if (!mdMatches) {
        fs.writeFileSync(partMdPath, chunk);
      }

      const reason = mdMatches ? "missing audio" : mdExisted ? "changed" : "new";
      progress(`Generating part ${partNum} of ${chunks.length}`);
      console.log(
        `🎙️  Generating part ${partNum}/${chunks.length} (${chunk.length} chars, ${reason})...`,
      );

      const size = await generateChunkAudio(chunk, partMp3Path);
      totalSize += size;
      partPaths.push(partMp3Path);
      regenerated++;
      regeneratedCharCount += chunk.length;
      console.log(`✅ Part ${partNum} generated (${(size / 1024).toFixed(1)} KB)`);
    }

    // Clean up stale part files left over from a previous, longer run.
    let staleNum = chunks.length + 1;
    while (true) {
      const stalePartBase = `${path.basename(audioPath, ".mp3")}-part${staleNum}`;
      const staleMdPath = path.join(tempDir, `${stalePartBase}.md`);
      const staleMp3Path = path.join(tempDir, `${stalePartBase}.mp3`);
      let removed = false;
      if (fs.existsSync(staleMdPath)) {
        fs.unlinkSync(staleMdPath);
        removed = true;
      }
      if (fs.existsSync(staleMp3Path)) {
        fs.unlinkSync(staleMp3Path);
        removed = true;
      }
      if (!removed) break;
      console.log(`🧹 Removed stale part ${staleNum}`);
      staleNum++;
    }

    // Merge parts if multiple chunks, otherwise copy single part to final path.
    if (chunks.length > 1) {
      progress(`Merging ${chunks.length} parts`);
      mergeAudioParts(partPaths, audioPath);
    } else {
      // Single chunk — copy (don't rename) so the part file survives for the
      // next run's cache check.
      fs.copyFileSync(partPaths[0], audioPath);
    }
    progress("Audio generation complete");

    const sizeKB = (totalSize / 1024).toFixed(1);
    const estimatedCredits = Math.ceil(regeneratedCharCount / 1000);

    console.log(`💾 Audio saved: ${path.basename(audioPath)}`);
    console.log(`📏 File size: ${sizeKB} KB`);
    if (skipped > 0) {
      console.log(
        `🔁 Reused ${skipped} cached part${skipped === 1 ? "" : "s"}, regenerated ${regenerated}`,
      );
    }
    console.log(`💳 Estimated credits used: ${estimatedCredits}`);

    return audioPath;
  } catch (error) {
    console.error(`❌ Error generating audio: ${error.message}`);
    throw error;
  }
}

// Command line usage
async function main() {
  const markdownPath = process.argv[2];

  if (!markdownPath) {
    console.error("Usage: eleven-tts <path-to-markdown-file>");
    process.exit(1);
  }

  try {
    await generateAudio(markdownPath);
    console.log("🎉 Audio generation complete!");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

// Export for programmatic use
module.exports = { generateAudio };

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}
