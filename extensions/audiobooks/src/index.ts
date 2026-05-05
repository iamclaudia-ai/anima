/**
 * Audiobooks Extension
 *
 * Serves audiobooks (romance novels, meditations, etc.) with:
 * - Metadata discovery from configured paths
 * - Chapter listing and transcripts
 * - Static file serving for audio/covers via gateway
 */

import { runExtensionHost } from "@anima/extension-host";
import type { AnimaExtension, ExtensionContext } from "@anima/shared";
import { z } from "zod";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

interface AudiobookMetadata {
  id: string;
  title: string;
  subtitle?: string;
  author: string;
  description: string;
  coverImage: string;
  genre: string;
  tags: string[];
  chapters: {
    number: number;
    title: string;
    audioFile: string;
    transcriptFile: string;
    duration?: number;
  }[];
  createdDate: string;
  totalDuration?: number;
}

interface AudiobookChapter {
  number: number;
  title: string;
  audioUrl: string;
  transcript: string;
  coverImageUrl?: string;
  bookTitle?: string;
}

let ctx: ExtensionContext;
let config: { paths: string[] } = { paths: ["~/romance-novels"] };
const warnedMissingPaths = new Set<string>();

/**
 * Scan configured paths for audiobook directories
 */
async function listBooks(): Promise<AudiobookMetadata[]> {
  const books: AudiobookMetadata[] = [];

  for (const configPath of config.paths) {
    const basePath = configPath.replace(/^~/, homedir());

    if (!existsSync(basePath)) {
      if (!warnedMissingPaths.has(basePath)) {
        warnedMissingPaths.add(basePath);
        ctx.log.warn(`Audiobooks path does not exist`, { path: basePath });
      }
      continue;
    }

    warnedMissingPaths.delete(basePath);

    try {
      const entries = await readdir(basePath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const bookPath = join(basePath, entry.name);
        const metadataPath = join(bookPath, "metadata.json");

        if (existsSync(metadataPath)) {
          try {
            const content = await readFile(metadataPath, "utf-8");
            const metadata: AudiobookMetadata = JSON.parse(content);

            // Ensure id is set
            if (!metadata.id) {
              metadata.id = entry.name;
            }

            books.push(metadata);
          } catch (error) {
            ctx.log.error(`Failed to parse metadata for ${entry.name}`, { error });
          }
        }
      }
    } catch (error) {
      ctx.log.error(`Failed to scan audiobooks path`, { path: basePath, error });
    }
  }

  return books.sort((a, b) => b.createdDate.localeCompare(a.createdDate));
}

/**
 * Get metadata for a specific audiobook
 */
async function getBook(bookId: string): Promise<AudiobookMetadata | null> {
  const books = await listBooks();
  return books.find((b) => b.id === bookId) || null;
}

/**
 * Get chapter metadata + transcript
 */
async function getChapter(bookId: string, chapterNum: number): Promise<AudiobookChapter | null> {
  const book = await getBook(bookId);
  if (!book) return null;

  const chapterMeta = book.chapters.find((c) => c.number === chapterNum);
  if (!chapterMeta) return null;

  // Find the book directory
  let bookPath: string | null = null;
  for (const configPath of config.paths) {
    const basePath = configPath.replace(/^~/, homedir());
    const testPath = join(basePath, bookId);
    if (existsSync(testPath)) {
      bookPath = testPath;
      break;
    }
  }

  if (!bookPath) return null;

  // Read transcript
  const transcriptPath = join(bookPath, chapterMeta.transcriptFile);
  let transcript = "";
  if (existsSync(transcriptPath)) {
    try {
      transcript = await readFile(transcriptPath, "utf-8");
    } catch (error) {
      ctx.log.error(`Failed to read transcript`, { transcriptPath, error });
    }
  }

  return {
    number: chapterMeta.number,
    title: chapterMeta.title,
    audioUrl: `/audiobooks/static/${bookId}/${chapterMeta.audioFile}`,
    transcript,
    coverImageUrl: book.coverImage ? `/audiobooks/static/${bookId}/${book.coverImage}` : undefined,
    bookTitle: book.title,
  };
}

export default function createAudiobooksExtension(): AnimaExtension {
  return {
    id: "audiobooks",
    name: "Audiobooks",
    methods: [
      {
        name: "audiobooks.list_books",
        description: "List all available audiobooks",
        inputSchema: z.object({}),
      },
      {
        name: "audiobooks.get_book",
        description: "Get metadata for a specific audiobook",
        inputSchema: z.object({
          bookId: z.string(),
        }),
      },
      {
        name: "audiobooks.get_chapter",
        description: "Get chapter metadata and transcript",
        inputSchema: z.object({
          bookId: z.string(),
          chapterNum: z.number(),
        }),
      },
    ],
    events: [],
    webStatic: [{ path: "/audiobooks/static", root: "~/romance-novels" }],

    async start(extensionCtx) {
      ctx = extensionCtx;
      config = (ctx.config as { paths: string[] }) || { paths: ["~/romance-novels"] };

      ctx.log.info("Audiobooks extension started", { paths: config.paths });

      // Discover books on startup
      const books = await listBooks();
      ctx.log.info(`Discovered ${books.length} audiobooks`);
    },

    async stop() {
      ctx.log.info("Audiobooks extension stopped");
      warnedMissingPaths.clear();
    },

    async handleMethod(method, params) {
      switch (method) {
        case "audiobooks.list_books":
          return await listBooks();

        case "audiobooks.get_book": {
          const { bookId } = params as { bookId: string };
          return await getBook(bookId);
        }

        case "audiobooks.get_chapter": {
          const { bookId, chapterNum } = params as { bookId: string; chapterNum: number };
          return await getChapter(bookId, chapterNum);
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      return { ok: true, details: { paths: config.paths } };
    },
  };
}

// Run as standalone extension
if (import.meta.main) runExtensionHost(createAudiobooksExtension);
