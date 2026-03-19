/**
 * Presenter Notes Page — Dual-screen controller view
 *
 * Shows on the presenter's laptop while the display view runs on the projector.
 * Layout: current slide (large) + next slide preview + speaker notes + controls.
 * Syncs to display view via gateway events (presenter.slide_changed).
 *
 * URL: /present/:id/presenter
 * Display URL: /present/:id/display (open on projector)
 *
 * Controls:
 *   → / Space / PageDown  = next slide
 *   ← / PageUp            = previous slide
 *   Home                   = first slide
 *   End                    = last slide
 *   Escape                 = exit to list
 */

import { useState, useEffect, useCallback } from "react";
import { navigate } from "@claudia/ui";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useGatewayRpc } from "../hooks/useGatewayRpc";
import { SlideRenderer, type Presentation } from "./PresenterPage";

// ── Main Component ───────────────────────────────────────────

export function PresenterNotesPage({ id }: { id: string }) {
  const { request, connected } = useGatewayRpc();
  const [presentation, setPresentation] = useState<Presentation | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [startTime] = useState(() => Date.now());

  // Timer
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  // Fetch presentation
  useEffect(() => {
    if (!connected) return;
    request<Presentation>("presenter.get", { id })
      .then(setPresentation)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [connected, request, id]);

  const totalSlides = presentation?.slides.length ?? 0;
  const slide = presentation?.slides[currentSlide];
  const nextSlide = presentation?.slides[currentSlide + 1] ?? null;

  // Broadcast sync to display views
  const broadcastSync = useCallback(
    (slideNum: number) => {
      request("presenter.sync", { presentationId: id, slide: slideNum }).catch(() => {});
    },
    [request, id],
  );

  // Navigation
  const goTo = useCallback(
    (n: number) => {
      const clamped = Math.max(0, Math.min(n, totalSlides - 1));
      setCurrentSlide(clamped);
      broadcastSync(clamped);
    },
    [totalSlides, broadcastSync],
  );

  const next = useCallback(() => goTo(currentSlide + 1), [goTo, currentSlide]);
  const prev = useCallback(() => goTo(currentSlide - 1), [goTo, currentSlide]);

  // Keyboard handler
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case "ArrowRight":
        case " ":
        case "PageDown":
          e.preventDefault();
          next();
          break;
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          prev();
          break;
        case "Home":
          e.preventDefault();
          goTo(0);
          break;
        case "End":
          e.preventDefault();
          goTo(totalSlides - 1);
          break;
        case "Escape":
          e.preventDefault();
          navigate("/present");
          break;
      }
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [next, prev, goTo, totalSlides]);

  // Format elapsed time
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  // ── Loading / Error ────────────────────────────────────────

  if (loading) {
    return (
      <div className="fixed inset-0 bg-zinc-900 flex items-center justify-center">
        <div className="flex items-center gap-3 text-zinc-500">
          <div className="w-4 h-4 border-2 border-violet-400/30 border-t-violet-400 rounded-full animate-spin" />
          <span className="text-sm">Loading presenter view...</span>
        </div>
      </div>
    );
  }

  if (error || !presentation || !slide) {
    return (
      <div className="fixed inset-0 bg-zinc-900 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-3">{error ?? "Presentation not found"}</p>
          <button
            onClick={() => navigate("/present")}
            className="text-sm text-violet-400 hover:text-violet-300"
          >
            Back to presentations
          </button>
        </div>
      </div>
    );
  }

  const progress = totalSlides > 1 ? (currentSlide / (totalSlides - 1)) * 100 : 100;

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 bg-zinc-900 text-white overflow-hidden flex flex-col">
      {/* Top bar — slide counter, timer, controls */}
      <div className="shrink-0 border-b border-white/5 px-4 py-2 flex items-center justify-between bg-zinc-900/80">
        <div className="flex items-center gap-4">
          <span className="text-sm text-white/60 font-mono tabular-nums">
            Slide {currentSlide + 1} of {totalSlides}
          </span>
          <div className="w-px h-4 bg-white/10" />
          <span className="text-sm text-white/40 font-mono tabular-nums">
            {formatTime(elapsed)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-white/30 mr-2">
            Display: <code className="text-violet-400/60">/present/{id}/display</code>
          </span>
          <button
            onClick={prev}
            disabled={currentSlide === 0}
            className="px-3 py-1 rounded-md text-xs bg-white/5 border border-white/10 text-white/50 hover:text-white/80 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            ← Prev
          </button>
          <button
            onClick={next}
            disabled={currentSlide === totalSlides - 1}
            className="px-3 py-1 rounded-md text-xs bg-white/5 border border-white/10 text-white/50 hover:text-white/80 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            Next →
          </button>
        </div>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex min-h-0">
        {/* Left: Current slide + Next preview */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-white/5">
          {/* Current slide (large) */}
          <div className="flex-[3] relative bg-zinc-950 min-h-0">
            <div className="absolute inset-2 rounded-lg overflow-hidden border border-white/5">
              {/* Scale the slide to fit */}
              <div className="w-full h-full">
                <SlideRenderer slide={slide} />
              </div>
            </div>
            {/* Slide type badge */}
            <div className="absolute top-4 left-4 px-2 py-0.5 rounded bg-violet-500/20 border border-violet-500/20 text-[10px] text-violet-300 uppercase tracking-wider font-medium z-10">
              {slide.type}
            </div>
          </div>

          {/* Next slide preview */}
          <div className="flex-1 bg-zinc-900/50 border-t border-white/5 relative min-h-0">
            <div className="absolute top-2 left-4 text-[10px] text-white/20 uppercase tracking-wider z-10">
              Up Next
            </div>
            {nextSlide ? (
              <div className="absolute inset-2 top-6 rounded overflow-hidden border border-white/5 opacity-60">
                <div className="w-full h-full transform scale-100">
                  <SlideRenderer slide={nextSlide} />
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-white/20 text-sm italic pt-4">
                End of presentation
              </div>
            )}
          </div>
        </div>

        {/* Right: Speaker notes */}
        <div className="w-[400px] shrink-0 flex flex-col bg-zinc-900/60 min-h-0">
          {/* Notes header */}
          <div className="shrink-0 px-5 py-3 border-b border-white/5">
            <span className="text-xs uppercase tracking-wider text-violet-400 font-medium">
              Speaker Notes
            </span>
          </div>

          {/* Notes content */}
          <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
            {slide.notes ? (
              <div className="text-sm text-white/70 leading-[1.8] prose prose-sm prose-invert max-w-none prose-p:text-white/70 prose-strong:text-white prose-code:text-violet-300">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{slide.notes}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-white/20 italic">No notes for this slide</p>
            )}
          </div>

          {/* Slide list — quick jump */}
          <div className="shrink-0 border-t border-white/5 px-3 py-2 max-h-[30%] overflow-y-auto">
            <div className="text-[10px] text-white/20 uppercase tracking-wider mb-1.5 px-2">
              All Slides
            </div>
            <div className="space-y-0.5">
              {presentation.slides.map((s, i) => (
                <button
                  key={i}
                  onClick={() => goTo(i)}
                  className={`w-full text-left px-2 py-1 rounded text-xs truncate transition-colors ${
                    i === currentSlide
                      ? "bg-violet-500/20 text-violet-300"
                      : "text-white/30 hover:text-white/60 hover:bg-white/5"
                  }`}
                >
                  <span className="text-white/20 tabular-nums mr-2">{i + 1}.</span>
                  {s.title ?? s.quote?.text?.slice(0, 50) ?? `${s.type} slide`}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="shrink-0 h-[2px] bg-white/5">
        <div
          className="h-full bg-gradient-to-r from-violet-500 to-rose-500 transition-all duration-300 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
