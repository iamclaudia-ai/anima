/**
 * Presenter Page — Fullscreen Slide Renderer
 *
 * Renders a presentation with keyboard navigation, progress bar,
 * and multiple slide types. Optimized for projection.
 *
 * Controls:
 *   → / Space / PageDown  = next slide
 *   ← / PageUp            = previous slide
 *   Home                   = first slide
 *   End                    = last slide
 *   F                      = toggle fullscreen
 *   N                      = toggle speaker notes
 *   Escape                 = exit to list
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { navigate } from "@anima/ui";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useGatewayRpc } from "../hooks/useGatewayRpc";

// ── Types ────────────────────────────────────────────────────

export interface Slide {
  type: string;
  title?: string;
  subtitle?: string;
  bullets?: (string | { text: string; sub?: string[] })[];
  code?: { language: string; content: string; highlight?: number[] };
  quote?: { text: string; attribution?: string };
  image?: { src: string; alt: string; position?: string };
  notes?: string;
  stats?: { label: string; value: string }[];
  label?: string;
  body?: string;
}

export interface Presentation {
  id: string;
  title: string;
  author: string;
  date?: string;
  theme?: string;
  slides: Slide[];
}

// ── Slide Renderers ──────────────────────────────────────────

function TitleSlide({ slide }: { slide: Slide }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-16 text-center">
      <div className="mb-8 opacity-60">
        <div className="w-16 h-1 bg-gradient-to-r from-violet-400 to-rose-400 rounded-full mx-auto" />
      </div>
      <h1
        className="text-7xl font-light tracking-tight text-white mb-6 leading-[1.1]"
        style={{ fontFamily: "'Newsreader', Georgia, serif" }}
      >
        {slide.title}
      </h1>
      {slide.subtitle && (
        <p className="text-2xl text-white/50 font-light tracking-wide">{slide.subtitle}</p>
      )}
    </div>
  );
}

function SectionSlide({ slide }: { slide: Slide }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-16 text-center">
      {slide.label && (
        <span className="text-sm uppercase tracking-[0.3em] text-violet-400 font-medium mb-6">
          {slide.label}
        </span>
      )}
      <h2
        className="text-6xl font-light tracking-tight text-white leading-[1.15]"
        style={{ fontFamily: "'Newsreader', Georgia, serif" }}
      >
        {slide.title}
      </h2>
      {slide.subtitle && (
        <p className="text-xl text-white/40 mt-6 max-w-2xl leading-relaxed">{slide.subtitle}</p>
      )}
    </div>
  );
}

function BulletsSlide({ slide }: { slide: Slide }) {
  return (
    <div className="flex flex-col justify-center h-full px-20 max-w-5xl mx-auto">
      {slide.label && (
        <span className="text-xs uppercase tracking-[0.3em] text-violet-400/80 font-medium mb-3">
          {slide.label}
        </span>
      )}
      {slide.title && (
        <h2
          className="text-4xl font-light tracking-tight text-white mb-12"
          style={{ fontFamily: "'Newsreader', Georgia, serif" }}
        >
          {slide.title}
        </h2>
      )}
      <ul className="space-y-5">
        {slide.bullets?.map((bullet, i) => {
          const text = typeof bullet === "string" ? bullet : bullet.text;
          const subs = typeof bullet === "string" ? undefined : bullet.sub;
          return (
            <li
              key={i}
              className="flex gap-4 items-start"
              style={{
                animation: "fadeSlideIn 0.4s ease-out both",
                animationDelay: `${i * 100}ms`,
              }}
            >
              <span className="w-2 h-2 rounded-full bg-violet-400/70 mt-3 shrink-0" />
              <div>
                <span className="text-xl text-white/90 leading-relaxed">{text}</span>
                {subs && (
                  <ul className="mt-2 ml-2 space-y-1.5">
                    {subs.map((sub, j) => (
                      <li key={j} className="flex gap-3 items-start">
                        <span className="w-1 h-1 rounded-full bg-white/20 mt-2.5 shrink-0" />
                        <span className="text-base text-white/50">{sub}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function QuoteSlide({ slide }: { slide: Slide }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-20 text-center max-w-4xl mx-auto">
      <div
        className="text-8xl text-violet-400/30 leading-none mb-4"
        style={{ fontFamily: "Georgia, serif" }}
      >
        &ldquo;
      </div>
      <blockquote
        className="text-3xl text-white/90 leading-[1.6] font-light italic"
        style={{ fontFamily: "'Newsreader', Georgia, serif" }}
      >
        {slide.quote?.text}
      </blockquote>
      {slide.quote?.attribution && (
        <p className="mt-8 text-base text-white/40 tracking-wide">— {slide.quote.attribution}</p>
      )}
    </div>
  );
}

function CodeSlide({ slide }: { slide: Slide }) {
  return (
    <div className="flex flex-col justify-center h-full px-20 max-w-5xl mx-auto">
      {slide.title && (
        <h2
          className="text-3xl font-light tracking-tight text-white mb-8"
          style={{ fontFamily: "'Newsreader', Georgia, serif" }}
        >
          {slide.title}
        </h2>
      )}
      <div className="rounded-2xl border border-white/10 bg-black/40 backdrop-blur-sm overflow-hidden shadow-2xl">
        {slide.code?.language && (
          <div className="px-5 py-3 border-b border-white/5 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-3 h-3 rounded-full bg-red-500/60" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
              <div className="w-3 h-3 rounded-full bg-green-500/60" />
            </div>
            <span className="text-xs text-white/30 ml-3 font-mono">{slide.code.language}</span>
          </div>
        )}
        <pre className="p-6 overflow-x-auto">
          <code className="text-base text-emerald-300/90 font-mono leading-relaxed whitespace-pre">
            {slide.code?.content}
          </code>
        </pre>
      </div>
    </div>
  );
}

function DemoSlide({ slide }: { slide: Slide }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-16 text-center">
      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-violet-500/20 to-rose-500/20 border border-white/10 flex items-center justify-center mb-8">
        <span className="text-4xl">🎬</span>
      </div>
      <h2
        className="text-5xl font-light tracking-tight text-white mb-4"
        style={{ fontFamily: "'Newsreader', Georgia, serif" }}
      >
        {slide.title ?? "Live Demo"}
      </h2>
      {slide.subtitle && <p className="text-xl text-white/40 max-w-2xl">{slide.subtitle}</p>}
      {slide.bullets && (
        <ul className="mt-10 space-y-3 text-left">
          {slide.bullets.map((bullet, i) => (
            <li key={i} className="flex gap-3 items-center text-lg text-white/60">
              <span className="w-6 h-6 rounded-full border border-white/20 flex items-center justify-center text-xs text-white/40 shrink-0">
                {i + 1}
              </span>
              {typeof bullet === "string" ? bullet : bullet.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BigStatSlide({ slide }: { slide: Slide }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-16 text-center">
      {slide.label && (
        <span className="text-sm uppercase tracking-[0.3em] text-violet-400 font-medium mb-8">
          {slide.label}
        </span>
      )}
      {slide.title && (
        <h2
          className="text-4xl font-light tracking-tight text-white mb-12"
          style={{ fontFamily: "'Newsreader', Georgia, serif" }}
        >
          {slide.title}
        </h2>
      )}
      <div className="flex gap-16 flex-wrap justify-center">
        {slide.stats?.map((stat, i) => (
          <div key={i} className="text-center">
            <div className="text-6xl font-light text-white tabular-nums mb-2">{stat.value}</div>
            <div className="text-sm text-white/40 uppercase tracking-wider">{stat.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SplitSlide({ slide }: { slide: Slide }) {
  return (
    <div className="flex h-full">
      {/* Left: text content */}
      <div className="flex-1 flex flex-col justify-center px-16">
        {slide.label && (
          <span className="text-xs uppercase tracking-[0.3em] text-violet-400/80 font-medium mb-3">
            {slide.label}
          </span>
        )}
        {slide.title && (
          <h2
            className="text-4xl font-light tracking-tight text-white mb-8"
            style={{ fontFamily: "'Newsreader', Georgia, serif" }}
          >
            {slide.title}
          </h2>
        )}
        {slide.bullets && (
          <ul className="space-y-4">
            {slide.bullets.map((bullet, i) => (
              <li key={i} className="flex gap-3 items-start">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400/70 mt-2.5 shrink-0" />
                <span className="text-lg text-white/80 leading-relaxed">
                  {typeof bullet === "string" ? bullet : bullet.text}
                </span>
              </li>
            ))}
          </ul>
        )}
        {slide.body && (
          <div className="prose prose-invert prose-lg max-w-none prose-p:text-white/70 prose-strong:text-white prose-code:text-violet-300 prose-code:bg-white/5 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{slide.body}</ReactMarkdown>
          </div>
        )}
      </div>
      {/* Right: image or code */}
      <div className="flex-1 flex items-center justify-center bg-white/[0.02] border-l border-white/5">
        {slide.image ? (
          <img
            src={slide.image.src}
            alt={slide.image.alt}
            className="max-w-full max-h-[80%] rounded-xl shadow-2xl"
          />
        ) : slide.code ? (
          <div className="w-full px-8">
            <div className="rounded-xl border border-white/10 bg-black/40 overflow-hidden">
              <pre className="p-5 overflow-x-auto">
                <code className="text-sm text-emerald-300/90 font-mono leading-relaxed whitespace-pre">
                  {slide.code.content}
                </code>
              </pre>
            </div>
          </div>
        ) : (
          <div className="text-white/20 text-lg italic">Visual content</div>
        )}
      </div>
    </div>
  );
}

function ImageSlide({ slide }: { slide: Slide }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-16">
      {slide.title && (
        <h2
          className="text-3xl font-light tracking-tight text-white mb-8"
          style={{ fontFamily: "'Newsreader', Georgia, serif" }}
        >
          {slide.title}
        </h2>
      )}
      {slide.image && (
        <img
          src={slide.image.src}
          alt={slide.image.alt}
          className="max-w-4xl max-h-[70vh] rounded-xl shadow-2xl"
        />
      )}
    </div>
  );
}

// ── Slide Renderer Dispatch ──────────────────────────────────

export function SlideRenderer({ slide }: { slide: Slide }) {
  switch (slide.type) {
    case "title":
      return <TitleSlide slide={slide} />;
    case "section":
      return <SectionSlide slide={slide} />;
    case "bullets":
      return <BulletsSlide slide={slide} />;
    case "quote":
      return <QuoteSlide slide={slide} />;
    case "code":
      return <CodeSlide slide={slide} />;
    case "demo":
      return <DemoSlide slide={slide} />;
    case "bigstat":
      return <BigStatSlide slide={slide} />;
    case "split":
      return <SplitSlide slide={slide} />;
    case "image":
      return <ImageSlide slide={slide} />;
    default:
      return <BulletsSlide slide={slide} />;
  }
}

// ── Main Page Component ──────────────────────────────────────

export function PresenterPage({ id, display }: { id: string; display?: boolean }) {
  const { request, connected, subscribe, on } = useGatewayRpc();
  const [presentation, setPresentation] = useState<Presentation | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.0);
  const isDisplay = display === true;
  const syncingRef = useRef(false);
  const scaleRef = useRef(1.0);

  // Parse initial slide from hash
  useEffect(() => {
    const hash = window.location.hash;
    if (hash) {
      const num = parseInt(hash.slice(1), 10);
      if (!isNaN(num) && num >= 0) setCurrentSlide(num);
    }
  }, []);

  // Fetch presentation
  useEffect(() => {
    if (!connected) return;
    request<Presentation>("presenter.get", { id })
      .then((data) => setPresentation(data))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [connected, request, id]);

  // Subscribe to slide sync events (display mode follows presenter)
  useEffect(() => {
    if (!connected || !isDisplay) return;
    subscribe(["presenter.slide_changed"]);
    const unsub = on("presenter.slide_changed", (_event, raw) => {
      const payload = raw as { presentationId: string; slide: number; scale?: number };
      if (payload.presentationId === id) {
        syncingRef.current = true;
        setCurrentSlide(payload.slide);
        if (payload.scale !== undefined) {
          setScale(payload.scale);
          scaleRef.current = payload.scale;
        }
        window.history.replaceState(null, "", `#${payload.slide}`);
        // Reset syncing flag after state update
        setTimeout(() => {
          syncingRef.current = false;
        }, 50);
      }
    });
    return unsub;
  }, [connected, isDisplay, subscribe, on, id]);

  const totalSlides = presentation?.slides.length ?? 0;
  const slide = presentation?.slides[currentSlide];

  // Broadcast slide change to display views
  const broadcastSync = useCallback(
    (slideNum: number, newScale?: number) => {
      if (isDisplay || syncingRef.current) return;
      request("presenter.sync", {
        presentationId: id,
        slide: slideNum,
        scale: newScale ?? scaleRef.current,
      }).catch(() => {});
    },
    [isDisplay, request, id],
  );

  // Navigation
  const goTo = useCallback(
    (n: number) => {
      const clamped = Math.max(0, Math.min(n, totalSlides - 1));
      setCurrentSlide(clamped);
      window.history.replaceState(null, "", `#${clamped}`);
      broadcastSync(clamped);
    },
    [totalSlides, broadcastSync],
  );

  const next = useCallback(() => goTo(currentSlide + 1), [goTo, currentSlide]);
  const prev = useCallback(() => goTo(currentSlide - 1), [goTo, currentSlide]);

  // Keyboard handler
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // Don't capture when typing in input
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
        case "f":
        case "F":
          e.preventDefault();
          if (document.fullscreenElement) {
            document.exitFullscreen();
          } else {
            document.documentElement.requestFullscreen();
          }
          break;
        case "n":
        case "N":
          e.preventDefault();
          setShowNotes((v) => !v);
          break;
        case "=":
        case "+":
          e.preventDefault();
          setScale((s) => {
            const next = Math.min(s + 0.1, 2.0);
            scaleRef.current = next;
            broadcastSync(currentSlide, next);
            return next;
          });
          break;
        case "-":
        case "_":
          e.preventDefault();
          setScale((s) => {
            const next = Math.max(s - 0.1, 0.5);
            scaleRef.current = next;
            broadcastSync(currentSlide, next);
            return next;
          });
          break;
        case "0":
          e.preventDefault();
          setScale(1.0);
          scaleRef.current = 1.0;
          broadcastSync(currentSlide, 1.0);
          break;
        case "Escape":
          e.preventDefault();
          if (document.fullscreenElement) {
            document.exitFullscreen();
          } else {
            navigate("/present");
          }
          break;
      }
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [next, prev, goTo, totalSlides, broadcastSync, currentSlide]);

  // Touch/swipe support
  useEffect(() => {
    let startX = 0;
    let startY = 0;

    function handleTouchStart(e: TouchEvent) {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }

    function handleTouchEnd(e: TouchEvent) {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
        if (dx < 0) next();
        else prev();
      }
    }

    window.addEventListener("touchstart", handleTouchStart);
    window.addEventListener("touchend", handleTouchEnd);
    return () => {
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchend", handleTouchEnd);
    };
  }, [next, prev]);

  // Scale the root font size — all rem-based Tailwind classes (text, spacing, etc.) scale naturally
  useEffect(() => {
    const html = document.documentElement;
    const original = html.style.fontSize;
    html.style.fontSize = `${scale * 100}%`;
    return () => {
      html.style.fontSize = original;
    };
  }, [scale]);

  // ── Loading / Error states ───────────────────────────────

  if (loading) {
    return (
      <div className="fixed inset-0 bg-zinc-950 flex items-center justify-center">
        <div className="flex items-center gap-3 text-zinc-500">
          <div className="w-4 h-4 border-2 border-violet-400/30 border-t-violet-400 rounded-full animate-spin" />
          <span className="text-sm">Loading presentation...</span>
        </div>
      </div>
    );
  }

  if (error || !presentation || !slide) {
    return (
      <div className="fixed inset-0 bg-zinc-950 flex items-center justify-center">
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

  // ── Render ───────────────────────────────────────────────

  const progress = totalSlides > 1 ? (currentSlide / (totalSlides - 1)) * 100 : 100;

  return (
    <div
      className="fixed inset-0 bg-zinc-950 text-white overflow-hidden select-none"
      style={{ cursor: "none" }}
      onMouseMove={(e) => {
        // Show cursor on movement, hide after idle
        const el = e.currentTarget;
        el.style.cursor = "default";
        clearTimeout((el as unknown as Record<string, unknown>).__cursorTimeout as number);
        (el as unknown as Record<string, unknown>).__cursorTimeout = setTimeout(() => {
          el.style.cursor = "none";
        }, 2000) as unknown as number;
      }}
    >
      {/* Animation keyframes */}
      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* Background atmosphere */}
      <div className="absolute inset-0 pointer-events-none">
        {/* Subtle radial gradient */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 80% 60% at 50% 40%, rgba(139,92,246,0.06) 0%, transparent 70%)",
          }}
        />
        {/* Noise texture overlay */}
        <div
          className="absolute inset-0 opacity-[0.015]"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='1'/%3E%3C/svg%3E\")",
          }}
        />
      </div>

      {/* Slide content */}
      <div className="relative h-full w-full" key={currentSlide}>
        <div
          className="h-full w-full"
          style={{
            animation: "fadeSlideIn 0.35s ease-out both",
          }}
        >
          <SlideRenderer slide={slide} />
        </div>
      </div>

      {/* Progress bar — thin line at bottom */}
      <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-white/5">
        <div
          className="h-full bg-gradient-to-r from-violet-500 to-rose-500 transition-all duration-300 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Slide counter — bottom right */}
      <div className="absolute bottom-4 right-6 text-xs text-white/20 tabular-nums font-mono">
        {currentSlide + 1} / {totalSlides}
      </div>

      {/* Click zones — invisible left/right halves for navigation */}
      <div className="absolute inset-0 flex pointer-events-auto" style={{ zIndex: 10 }}>
        <div className="w-1/3 h-full" onClick={prev} />
        <div className="w-1/3 h-full" /> {/* Center — no action */}
        <div className="w-1/3 h-full" onClick={next} />
      </div>

      {/* Speaker notes overlay */}
      {showNotes && slide.notes && (
        <div className="absolute bottom-12 left-6 right-6 max-h-[30vh] overflow-y-auto z-20">
          <div className="rounded-xl border border-white/10 bg-black/80 backdrop-blur-xl p-5 shadow-2xl">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs uppercase tracking-wider text-violet-400 font-medium">
                Speaker Notes
              </span>
              <button
                onClick={() => setShowNotes(false)}
                className="ml-auto text-white/30 hover:text-white/60 text-xs"
              >
                ✕
              </button>
            </div>
            <div className="text-sm text-white/70 leading-relaxed prose prose-sm prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{slide.notes}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
