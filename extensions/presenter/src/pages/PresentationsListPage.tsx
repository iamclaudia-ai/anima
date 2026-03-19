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
          <div className="space-y-4">
            {presentations.map((pres) => (
              <Link key={pres.id} to={`/present/${pres.id}`} className="block no-underline group">
                <div className="rounded-xl border border-white/5 bg-white/[0.02] p-6 transition-all duration-300 hover:border-violet-500/30 hover:bg-white/[0.04] hover:shadow-lg hover:shadow-violet-500/5">
                  <div className="flex items-start justify-between">
                    <div>
                      <h2
                        className="text-xl text-white/90 font-light tracking-tight group-hover:text-white transition-colors"
                        style={{ fontFamily: "'Newsreader', Georgia, serif" }}
                      >
                        {pres.title}
                      </h2>
                      <div className="flex items-center gap-3 mt-2 text-sm text-white/30">
                        <span>{pres.author}</span>
                        {pres.date && (
                          <>
                            <span className="text-white/10">&middot;</span>
                            <span>{pres.date}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-white/20">
                      <span className="tabular-nums">{pres.slideCount} slides</span>
                      <span className="text-violet-400/50 opacity-0 group-hover:opacity-100 transition-opacity">
                        &rarr;
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
