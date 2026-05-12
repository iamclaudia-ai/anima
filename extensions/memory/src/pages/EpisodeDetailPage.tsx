/**
 * Episode Detail Page
 *
 * Shows the full Libby-generated episode markdown from ~/memory/episodes/.
 * Renders the complete narrative with ReactMarkdown for rich formatting.
 * Falls back to DB summary if episode file isn't available.
 */

import { useState, useEffect, useCallback } from "react";
import { Link } from "@anima/ui";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useGatewayRpc } from "../hooks/useGatewayRpc";

// ── Types ────────────────────────────────────────────────────

interface EpisodeData {
  conversationId: number;
  status: string;
  episodePath: string;
  found: boolean;
  content: string | null;
}

interface TranscriptData {
  conversationId: number;
  status: string;
  summary: string | null;
  date: string;
  timeRange: string;
  cwd: string;
  entryCount: number;
  chars: number;
  transcript: string;
}

// ── Helpers ──────────────────────────────────────────────────

function shortenCwd(cwd: string): string {
  return cwd.replace(/^\/Users\/\w+/, "~");
}

function formatDate(dateStr: string): string {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const [year, month, day] = dateStr.split("-").map(Number);
  return `${months[month - 1]} ${day}, ${year}`;
}

/** Extract metadata lines from episode markdown */
function parseEpisodeMetadata(content: string): {
  topics: string | null;
  mood: string | null;
  project: string | null;
  bodyMarkdown: string;
} {
  const lines = content.split("\n");
  let topics: string | null = null;
  let mood: string | null = null;
  let project: string | null = null;
  const bodyLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("**Topics:**")) {
      topics = trimmed.replace("**Topics:**", "").trim();
    } else if (trimmed.startsWith("**Mood:**")) {
      mood = trimmed.replace("**Mood:**", "").trim();
    } else if (trimmed.startsWith("**Project:**")) {
      project = trimmed.replace("**Project:**", "").trim();
    } else {
      bodyLines.push(line);
    }
  }

  return {
    topics,
    mood,
    project,
    bodyMarkdown: bodyLines.join("\n").trim(),
  };
}

function moodToEmoji(mood: string): string {
  const moodMap: Record<string, string> = {
    productive: "⚡",
    celebratory: "🎉",
    frustrated: "😤",
    determined: "💪",
    triumphant: "🏆",
    playful: "🎭",
    focused: "🎯",
    creative: "✨",
    reflective: "🪞",
    tired: "😴",
    excited: "🔥",
    loving: "💙",
    curious: "🔍",
    persistent: "🔨",
    satisfied: "😌",
    warm: "☀️",
    intimate: "💕",
  };

  return mood
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .map((m) => moodMap[m] ?? "")
    .filter(Boolean)
    .join(" ");
}

// ── Main Page Component ──────────────────────────────────────

export function EpisodeDetailPage({ id }: { id: string }) {
  const { request, connected } = useGatewayRpc();
  const [episode, setEpisode] = useState<EpisodeData | null>(null);
  const [transcript, setTranscript] = useState<TranscriptData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showTranscript, setShowTranscript] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchEpisode = useCallback(async () => {
    if (!connected) return;
    try {
      // Fetch episode file and transcript data in parallel
      const [episodeResult, transcriptResult] = await Promise.all([
        request<EpisodeData>("memory.get_episode", { id: parseInt(id, 10) }),
        request<TranscriptData>("memory.get_transcript", { id: parseInt(id, 10) }),
      ]);
      setEpisode(episodeResult);
      setTranscript(transcriptResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load episode");
    } finally {
      setLoading(false);
    }
  }, [connected, request, id]);

  useEffect(() => {
    setLoading(true);
    fetchEpisode();
  }, [fetchEpisode]);

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <div className="flex items-center gap-3 text-stone-400">
          <div className="size-4 border-2 border-violet-300 border-t-violet-500 rounded-full animate-spin" />
          <span className="text-sm">Loading episode...</span>
        </div>
      </div>
    );
  }

  if (error || !transcript) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-500 mb-3">{error ?? "Episode not found"}</p>
          <Link to="/memory" className="text-sm text-violet-500 hover:text-violet-600">
            Back to calendar
          </Link>
        </div>
      </div>
    );
  }

  // Use episode file if available, otherwise fall back to DB summary
  const episodeContent = episode?.found && episode.content ? episode.content : transcript.summary;

  const meta = episodeContent ? parseEpisodeMetadata(episodeContent) : null;
  const dateStr = transcript.date;

  return (
    <div className="min-h-screen bg-stone-50 text-stone-800">
      {/* Soft gradient */}
      <div className="absolute inset-x-0 top-0 h-80 bg-gradient-to-b from-violet-50/40 to-transparent pointer-events-none" />

      {/* Header */}
      <div className="relative border-b border-stone-200/80 px-6 py-5">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3">
            <Link
              to={transcript.date ? `/memory/day/${dateStr}` : "/memory"}
              className="text-stone-400 hover:text-stone-600 transition-colors"
            >
              &larr;
            </Link>
            <div>
              <div className="flex items-center gap-2 mb-0.5">
                <div className="size-2 rounded-full bg-emerald-400" />
                <span className="text-xs text-emerald-600 uppercase tracking-wider font-semibold">
                  Episode #{id}
                </span>
                {episode?.found && (
                  <span className="text-xs text-stone-300 font-mono">
                    {episode.episodePath.split("/").pop()}
                  </span>
                )}
              </div>
              <h1
                className="text-xl tracking-tight text-stone-700"
                style={{ fontFamily: "'Newsreader', 'Georgia', serif" }}
              >
                {formatDate(dateStr)}
              </h1>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="relative max-w-3xl mx-auto px-6 py-8">
        {/* Metadata pills */}
        <div className="flex flex-wrap gap-2 mb-8">
          {meta?.project && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-stone-200/80 shadow-sm">
              <svg className="size-3 text-stone-400" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.879a1.5 1.5 0 011.06.44l1.122 1.12A1.5 1.5 0 009.62 4H13.5A1.5 1.5 0 0115 5.5v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
              </svg>
              <span className="text-xs text-stone-500 font-mono">{shortenCwd(meta.project)}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-stone-200/80 shadow-sm">
            <span className="text-xs text-stone-400">Messages</span>
            <span className="text-xs text-stone-600 font-medium tabular-nums">
              {transcript.entryCount}
            </span>
          </div>
          {transcript.timeRange && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-stone-200/80 shadow-sm">
              <span className="text-xs text-stone-400">Time</span>
              <span className="text-xs text-stone-600 font-medium">{transcript.timeRange}</span>
            </div>
          )}
          {meta?.mood && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-stone-200/80 shadow-sm">
              <span className="text-xs">{moodToEmoji(meta.mood)}</span>
              <span className="text-xs text-stone-500">{meta.mood}</span>
            </div>
          )}
          {!episode?.found && transcript.summary && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200/60 shadow-sm">
              <span className="text-xs text-amber-600">
                Showing DB summary — episode file not found
              </span>
            </div>
          )}
        </div>

        {/* Narrative body — full episode markdown */}
        {meta?.bodyMarkdown ? (
          <article
            className="prose prose-stone max-w-none mb-8 prose-headings:text-stone-700 prose-h2:text-lg prose-h2:font-medium prose-h2:text-stone-500 prose-h2:border-b prose-h2:border-stone-200/60 prose-h2:pb-2 prose-p:text-stone-600 prose-p:leading-[1.8] prose-strong:text-stone-700 prose-em:text-violet-600/80 prose-code:text-violet-600 prose-code:bg-violet-50 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:before:content-[''] prose-code:after:content-[''] prose-a:text-violet-600 prose-a:no-underline hover:prose-a:underline prose-blockquote:border-violet-200 prose-blockquote:text-stone-500 prose-blockquote:italic prose-li:text-stone-600 prose-hr:border-stone-200/60"
            style={{ fontFamily: "'Newsreader', 'Georgia', serif" }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{meta.bodyMarkdown}</ReactMarkdown>
          </article>
        ) : (
          <div className="py-12 text-center">
            <p className="text-stone-400 italic">
              This conversation hasn't been processed by Libby yet.
            </p>
          </div>
        )}

        {/* Topics */}
        {meta?.topics && (
          <div className="mb-8 pt-6 border-t border-stone-200/60">
            <h3 className="text-xs text-stone-400 uppercase tracking-wider mb-3">Topics</h3>
            <div className="flex flex-wrap gap-1.5">
              {meta.topics.split(",").map((topic) => {
                const trimmed = topic.trim();
                return (
                  <span
                    key={trimmed}
                    className="px-2.5 py-1 rounded-md text-xs bg-white border border-stone-200/80 text-stone-500 shadow-sm"
                  >
                    {trimmed}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Transcript toggle */}
        <div className="border-t border-stone-200/60 pt-6">
          <button
            onClick={() => setShowTranscript(!showTranscript)}
            className="flex items-center gap-2 text-sm text-stone-400 hover:text-stone-600 transition-colors"
          >
            <svg
              className={`size-4 transition-transform ${showTranscript ? "rotate-90" : ""}`}
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z" />
            </svg>
            <span>Raw Transcript</span>
            <span className="text-xs text-stone-300">
              ({(transcript.chars / 1000).toFixed(1)}K chars)
            </span>
          </button>

          {showTranscript && (
            <div className="mt-4 rounded-xl border border-stone-200/80 bg-white p-5 max-h-[60vh] overflow-y-auto shadow-sm prose prose-sm prose-stone max-w-none prose-p:text-stone-500 prose-p:leading-relaxed prose-headings:text-stone-600 prose-strong:text-stone-600 prose-code:text-violet-600 prose-code:bg-violet-50 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:before:content-[''] prose-code:after:content-[''] prose-hr:border-stone-200/60 prose-li:text-stone-500">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{transcript.transcript}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
