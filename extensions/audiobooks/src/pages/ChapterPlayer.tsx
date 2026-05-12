/**
 * ChapterPlayer — Audible-style audio player with scrollable transcript
 */

import { useState, useEffect, useRef, useMemo, type CSSProperties } from "react";
import { useRouter, useGatewayClient } from "@anima/ui";
import ReactMarkdown from "react-markdown";

const FIXED_PLAYER_BAR: CSSProperties = {
  position: "fixed",
  bottom: 0,
  left: 0,
  right: 0,
  background: "#1a1a1a",
  borderTop: "1px solid #2a2a2a",
  padding: "1rem 1.5rem",
  boxShadow: "0 -4px 12px rgba(0,0,0,0.3)",
  zIndex: 1000,
};

interface Chapter {
  number: number;
  title: string;
  audioUrl: string;
  transcript: string;
  coverImageUrl?: string;
  bookTitle?: string;
}

export function ChapterPlayer() {
  const { params } = useRouter();
  const bookId = useMemo(() => params.bookId as string, [params.bookId]);
  const chapterNum = useMemo(
    () => Number.parseInt(params.chapterNum as string) || 1,
    [params.chapterNum],
  );
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const saveIntervalRef = useRef<number | null>(null);
  const hasRestoredRef = useRef(false);
  const { call } = useGatewayClient();

  useEffect(() => {
    async function loadChapter() {
      try {
        const result = (await call("audiobooks.get_chapter", {
          bookId,
          chapterNum,
        })) as Chapter;
        setChapter(result);
      } catch (error) {
        console.error("Failed to load chapter:", error);
      } finally {
        setLoading(false);
      }
    }
    loadChapter();
    // Reset restoration flag when chapter changes
    hasRestoredRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, chapterNum]);

  // Restore positions once audio is ready
  useEffect(() => {
    if (!chapter || hasRestoredRef.current) return;

    const audio = audioRef.current;
    if (!audio) return;

    // Wait for audio to be ready with duration
    const checkReady = () => {
      if (!audio.duration || !Number.isFinite(audio.duration)) {
        return false;
      }

      const positionKey = `audiobook-position-${bookId}-${chapterNum}`;
      const scrollKey = `audiobook-scroll-${bookId}-${chapterNum}`;

      // Restore audio position
      const savedPosition = localStorage.getItem(positionKey);
      if (savedPosition) {
        const position = Number.parseFloat(savedPosition);
        if (position > 0 && position < audio.duration) {
          try {
            audio.currentTime = position;
            console.log(`[ChapterPlayer] Restored audio position: ${position.toFixed(1)}s`);
          } catch (error) {
            console.warn("[ChapterPlayer] Failed to restore audio position:", error);
          }
        }
      }

      // Restore scroll position
      const savedScroll = localStorage.getItem(scrollKey);
      if (savedScroll && scrollContainerRef.current) {
        const scrollTop = Number.parseInt(savedScroll, 10);
        scrollContainerRef.current.scrollTop = scrollTop;
        console.log(`[ChapterPlayer] Restored scroll position: ${scrollTop}px`);
      }

      hasRestoredRef.current = true;
      return true;
    };

    // Try immediately
    if (checkReady()) return;

    // Poll until ready
    const interval = setInterval(() => {
      if (checkReady()) {
        clearInterval(interval);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [chapter, bookId, chapterNum]);

  // Save audio position and scroll position periodically
  useEffect(() => {
    const positionKey = `audiobook-position-${bookId}-${chapterNum}`;
    const scrollKey = `audiobook-scroll-${bookId}-${chapterNum}`;

    if (isPlaying) {
      saveIntervalRef.current = window.setInterval(() => {
        if (audioRef.current) {
          const position = audioRef.current.currentTime;
          localStorage.setItem(positionKey, position.toString());
        }
        if (scrollContainerRef.current) {
          const scrollTop = scrollContainerRef.current.scrollTop;
          localStorage.setItem(scrollKey, scrollTop.toString());
        }
      }, 3000);
    } else {
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
        saveIntervalRef.current = null;
      }
    }

    return () => {
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
      }
    };
  }, [isPlaying, bookId, chapterNum]);

  // Save position on pause/seek
  function savePosition() {
    const positionKey = `audiobook-position-${bookId}-${chapterNum}`;
    const scrollKey = `audiobook-scroll-${bookId}-${chapterNum}`;

    if (audioRef.current) {
      const position = audioRef.current.currentTime;
      localStorage.setItem(positionKey, position.toString());
    }
    if (scrollContainerRef.current) {
      const scrollTop = scrollContainerRef.current.scrollTop;
      localStorage.setItem(scrollKey, scrollTop.toString());
    }
  }

  // Save scroll position on scroll
  const handleScroll = () => {
    if (scrollContainerRef.current) {
      const scrollTop = scrollContainerRef.current.scrollTop;
      const scrollKey = `audiobook-scroll-${bookId}-${chapterNum}`;
      localStorage.setItem(scrollKey, scrollTop.toString());
    }
  };

  if (loading) {
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f0f0f",
          color: "#fff",
        }}
      >
        <div>Loading chapter...</div>
      </div>
    );
  }

  if (!chapter) {
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f0f0f",
          color: "#fff",
          flexDirection: "column",
        }}
      >
        <h2 style={{ marginBottom: "1rem" }}>Chapter Not Found</h2>
        <a href={`/audiobooks/${bookId}`} style={{ color: "#8b5cf6", textDecoration: "none" }}>
          ← Back to Book
        </a>
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#0f0f0f",
        color: "#fff",
        overflow: "hidden",
      }}
    >
      {/* Scrollable content area (cover + transcript) */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          paddingBottom: "120px", // Space for fixed player
          WebkitOverflowScrolling: "touch",
        }}
      >
        {/* Cover Image */}
        {chapter.coverImageUrl && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              padding: "2rem",
              background: "linear-gradient(180deg, #1a1a1a 0%, #0f0f0f 100%)",
            }}
          >
            <img
              src={chapter.coverImageUrl}
              alt={chapter.bookTitle || "Book cover"}
              style={{
                maxWidth: "300px",
                width: "100%",
                borderRadius: "12px",
                boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
              }}
            />
          </div>
        )}

        {/* Chapter Info */}
        <div
          style={{
            padding: "1.5rem 1.5rem 0.5rem",
            textAlign: "center",
            borderBottom: "1px solid #2a2a2a",
          }}
        >
          <div style={{ fontSize: "0.875rem", color: "#888", marginBottom: "0.25rem" }}>
            {chapter.bookTitle || ""}
          </div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: "600", margin: "0" }}>
            Chapter {chapter.number}: {chapter.title}
          </h1>
        </div>

        {/* Transcript */}
        {chapter.transcript && (
          <div
            style={{
              padding: "2rem 1.5rem",
              maxWidth: "700px",
              margin: "0 auto",
              lineHeight: "1.8",
              color: "#d4d4d4",
            }}
          >
            <ReactMarkdown
              components={{
                h1: ({ children }) => (
                  <h1
                    style={{
                      fontSize: "1.75rem",
                      fontWeight: "600",
                      marginBottom: "1rem",
                      color: "#fff",
                    }}
                  >
                    {children}
                  </h1>
                ),
                h2: ({ children }) => (
                  <h2
                    style={{
                      fontSize: "1.4rem",
                      fontWeight: "600",
                      marginTop: "1.5rem",
                      marginBottom: "0.75rem",
                      color: "#fff",
                    }}
                  >
                    {children}
                  </h2>
                ),
                h3: ({ children }) => (
                  <h3
                    style={{
                      fontSize: "1.2rem",
                      fontWeight: "600",
                      marginTop: "1.25rem",
                      marginBottom: "0.5rem",
                      color: "#fff",
                    }}
                  >
                    {children}
                  </h3>
                ),
                p: ({ children }) => (
                  <p
                    style={{
                      fontFamily: "Georgia, serif",
                      fontSize: "1.0625rem",
                      marginBottom: "1rem",
                      color: "#d4d4d4",
                    }}
                  >
                    {children}
                  </p>
                ),
                em: ({ children }) => (
                  <em style={{ fontStyle: "italic", color: "#e4e4e4" }}>{children}</em>
                ),
                strong: ({ children }) => (
                  <strong style={{ fontWeight: "600", color: "#fff" }}>{children}</strong>
                ),
                hr: () => (
                  <hr
                    style={{
                      margin: "2rem 0",
                      border: "none",
                      borderTop: "1px solid #2a2a2a",
                    }}
                  />
                ),
              }}
            >
              {chapter.transcript}
            </ReactMarkdown>
          </div>
        )}
      </div>

      {/* Fixed Player at Bottom */}
      <div style={FIXED_PLAYER_BAR}>
        <audio
          ref={audioRef}
          src={chapter.audioUrl}
          controls
          preload="metadata"
          style={{
            width: "100%",
            height: "50px",
            background: "transparent",
          }}
          onPlay={() => setIsPlaying(true)}
          onPause={() => {
            setIsPlaying(false);
            savePosition();
          }}
          onEnded={() => {
            setIsPlaying(false);
            // Clear saved position when chapter completes
            const positionKey = `audiobook-position-${bookId}-${chapterNum}`;
            const scrollKey = `audiobook-scroll-${bookId}-${chapterNum}`;
            localStorage.removeItem(positionKey);
            localStorage.removeItem(scrollKey);
          }}
          onSeeked={savePosition}
        />
      </div>
    </div>
  );
}
