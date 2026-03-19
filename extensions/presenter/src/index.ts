/**
 * Presenter Extension — Server
 *
 * Serves slide deck data from JSON files in data/presentations/.
 * Each presentation is a JSON file with slides, metadata, and speaker notes.
 */

import { z } from "zod";
import { join } from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import type { ClaudiaExtension, ExtensionContext, HealthCheckResponse } from "@claudia/shared";

// ── Types ────────────────────────────────────────────────────

export interface Slide {
  type: "title" | "section" | "bullets" | "code" | "quote" | "image" | "split" | "demo" | "bigstat";
  title?: string;
  subtitle?: string;
  bullets?: (string | { text: string; sub?: string[] })[];
  code?: { language: string; content: string; highlight?: number[] };
  quote?: { text: string; attribution?: string };
  image?: { src: string; alt: string; position?: "full" | "right" | "left" };
  notes?: string;
  /** Extra key-value pairs shown as large stat callouts for "bigstat" type */
  stats?: { label: string; value: string }[];
  /** Section label shown above the title (e.g. "Pillar 1") */
  label?: string;
  /** Markdown body for rich free-form content */
  body?: string;
}

export interface Presentation {
  id: string;
  title: string;
  author: string;
  date?: string;
  theme?: "dark" | "light" | "claudia";
  slides: Slide[];
}

// ── Data loading ─────────────────────────────────────────────

const DATA_DIR = join(import.meta.dir, "..", "data", "presentations");

function loadPresentation(id: string): Presentation | null {
  const filePath = join(DATA_DIR, `${id}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return { ...JSON.parse(raw), id };
  } catch {
    return null;
  }
}

function listPresentations(): {
  id: string;
  title: string;
  author: string;
  slideCount: number;
  date?: string;
}[] {
  if (!existsSync(DATA_DIR)) return [];
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  const results: {
    id: string;
    title: string;
    author: string;
    slideCount: number;
    date?: string;
  }[] = [];

  for (const file of files) {
    const id = file.replace(/\.json$/, "");
    const pres = loadPresentation(id);
    if (pres) {
      results.push({
        id,
        title: pres.title,
        author: pres.author,
        slideCount: pres.slides.length,
        date: pres.date,
      });
    }
  }

  return results;
}

// ── Extension Factory ────────────────────────────────────────

export function createPresenterExtension(config: Record<string, unknown> = {}): ClaudiaExtension {
  let ctx: ExtensionContext | null = null;

  return {
    id: "presenter",
    name: "Presenter",
    methods: [
      {
        name: "presenter.health_check",
        description: "Return health status",
        inputSchema: z.object({}),
      },
      {
        name: "presenter.list",
        description: "List all available presentations",
        inputSchema: z.object({}),
      },
      {
        name: "presenter.get",
        description: "Get a presentation by ID",
        inputSchema: z.object({
          id: z.string().describe("Presentation ID (filename without .json)"),
        }),
      },
      {
        name: "presenter.sync",
        description: "Broadcast current slide to all display views",
        inputSchema: z.object({
          presentationId: z.string(),
          slide: z.number(),
        }),
      },
    ],
    events: ["presenter.slide_changed"],

    async start(context: ExtensionContext) {
      ctx = context;
      const presentations = listPresentations();
      ctx.log.info(`Presenter extension started — ${presentations.length} presentation(s) found`);
    },

    async stop() {
      ctx = null;
    },

    async handleMethod(method: string, params: Record<string, unknown>) {
      switch (method) {
        case "presenter.health_check": {
          const presentations = listPresentations();
          return {
            ok: true,
            status: "healthy",
            label: "Presenter",
            metrics: [{ label: "Presentations", value: presentations.length }],
          } as HealthCheckResponse;
        }

        case "presenter.list":
          return { presentations: listPresentations() };

        case "presenter.get": {
          const id = params.id as string;
          const pres = loadPresentation(id);
          if (!pres) throw new Error(`Presentation not found: ${id}`);
          return pres;
        }

        case "presenter.sync": {
          const { presentationId, slide } = params as { presentationId: string; slide: number };
          ctx?.emit("presenter.slide_changed", { presentationId, slide });
          return { ok: true, slide };
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      return { ok: true } as HealthCheckResponse;
    },
  };
}

export default createPresenterExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@claudia/extension-host";
if (import.meta.main) runExtensionHost(createPresenterExtension);
