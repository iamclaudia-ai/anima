/**
 * Presentations List Page
 *
 * Shows all available presentations with a card for each.
 * Click to launch presenter mode.
 */

import { useState, useEffect } from "react";
import { Link } from "@claudia/ui";
import { useGatewayRpc } from "../hooks/useGatewayRpc";

interface PresentationSummary {
  id: string;
  title: string;
  author: string;
  slideCount: number;
  date?: string;
}

export function PresentationsListPage() {
  const { request, connected } = useGatewayRpc();
  const [presentations, setPresentations] = useState<PresentationSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!connected) return;
    request<{ presentations: PresentationSummary[] }>("presenter.list")
      .then((data) => setPresentations(data.presentations))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [connected, request]);

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {/* Atmosphere */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 0%, rgba(139,92,246,0.08) 0%, transparent 60%)",
        }}
      />

      {/* Header */}
      <div className="relative border-b border-white/5 px-8 py-6">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-white/30 hover:text-white/60 transition-colors">
              &larr;
            </Link>
            <div>
              <h1
                className="text-2xl tracking-tight text-white/90"
                style={{ fontFamily: "'Newsreader', Georgia, serif" }}
              >
                Presentations
              </h1>
              <p className="text-sm text-white/30 mt-0.5">
                Powered by Claudia &middot; press{" "}
                <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[10px] font-mono">
                  F
                </kbd>{" "}
                for fullscreen
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="relative max-w-3xl mx-auto px-8 py-12">
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="flex items-center gap-3 text-white/40">
              <div className="w-4 h-4 border-2 border-violet-400/30 border-t-violet-400 rounded-full animate-spin" />
              <span className="text-sm">Loading presentations...</span>
            </div>
          </div>
        ) : presentations.length === 0 ? (
          <div className="text-center py-24">
            <p className="text-white/40 mb-2">No presentations found</p>
            <p className="text-sm text-white/20">
              Add JSON files to{" "}
              <code className="text-violet-400/60">extensions/presenter/data/presentations/</code>
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {presentations.map((pres) => (
              <div
                key={pres.id}
                className="rounded-xl border border-white/5 bg-white/[0.02] p-6 transition-all duration-300 hover:border-violet-500/30 hover:bg-white/[0.04]"
              >
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h2
                      className="text-xl text-white/90 font-light tracking-tight"
                      style={{ fontFamily: "'Newsreader', Georgia, serif" }}
                    >
                      {pres.title}
                    </h2>
                    <div className="flex items-center gap-3 mt-1.5 text-sm text-white/30">
                      <span>{pres.author}</span>
                      {pres.date && (
                        <>
                          <span className="text-white/10">&middot;</span>
                          <span>{pres.date}</span>
                        </>
                      )}
                      <span className="text-white/10">&middot;</span>
                      <span className="tabular-nums">{pres.slideCount} slides</span>
                    </div>
                  </div>
                </div>

                {/* Mode links */}
                <div className="flex items-center gap-2">
                  <Link
                    to={`/present/${pres.id}`}
                    className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-sm text-violet-300 hover:bg-violet-500/20 hover:text-violet-200 transition-all no-underline"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3zm12 9.5H2v.5a1 1 0 001 1h10a1 1 0 001-1v-.5z" />
                    </svg>
                    Standalone
                  </Link>
                  <Link
                    to={`/present/${pres.id}/presenter`}
                    className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white/50 hover:bg-white/10 hover:text-white/80 transition-all no-underline"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M5 4a.5.5 0 00-.5.5v7a.5.5 0 001 0V8h4v3.5a.5.5 0 001 0v-7a.5.5 0 00-1 0V7h-4V4.5A.5.5 0 005 4z" />
                      <path d="M1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11z" />
                    </svg>
                    Presenter Notes
                  </Link>
                  <Link
                    to={`/present/${pres.id}/display`}
                    className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white/50 hover:bg-white/10 hover:text-white/80 transition-all no-underline"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M0 4s0-2 2-2h12s2 0 2 2v6s0 2-2 2h-4l.5 2H12v1H4v-1h1.5l.5-2H2s-2 0-2-2V4zm1.398-.855a.758.758 0 00-.254.302A1.46 1.46 0 001 4.01V10c0 .325.078.502.145.602.07.105.17.188.302.254a1.46 1.46 0 00.538.143L2.01 11H14c.325 0 .502-.078.602-.145a.758.758 0 00.254-.302 1.46 1.46 0 00.143-.538L15 9.99V4c0-.325-.078-.502-.145-.602a.757.757 0 00-.302-.254A1.46 1.46 0 0013.99 3H2c-.325 0-.502.078-.602.145z" />
                    </svg>
                    Display
                  </Link>
                </div>

                {/* Help text */}
                <p className="mt-3 text-xs text-white/15">
                  Right-click any link to open in a new window &middot; Use Presenter Notes on your
                  laptop and Display on the projector
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
