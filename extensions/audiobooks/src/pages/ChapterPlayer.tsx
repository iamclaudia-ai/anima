/**
 * ChapterPlayer — Audio player with transcript
 */

import { useState, useEffect, useRef } from "react";
import { Link, useRouter, useGatewayClient } from "@claudia/ui";
import ReactMarkdown from "react-markdown";

const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;

interface Chapter {
  number: number;
  title: string;
  audioUrl: string;
  transcript: string;
}

export function ChapterPlayer() {
  const { params } = useRouter();
  const bookId = params.bookId as string;
  const chapterNum = Number.parseInt(params.chapterNum as string);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const saveIntervalRef = useRef<number | null>(null);
  const { call } = useGatewayClient(WS_URL);

  const getPositionKey = () => `audiobook-position-${bookId}-${chapterNum}`;

  useEffect(() => {
    loadChapter();
  }, [bookId, chapterNum]);

  useEffect(() => {
    // Load saved position when audio is ready
    const audio = audioRef.current;
    if (!audio) return;

    const handleLoadedMetadata = () => {
      const savedPosition = localStorage.getItem(getPositionKey());
      if (savedPosition) {
        const position = Number.parseFloat(savedPosition);
        if (position > 0 && position < audio.duration) {
          audio.currentTime = position;
          console.log(`[ChapterPlayer] Restored position: ${position}s`);
        }
      }
    };

    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    return () => audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
  }, [bookId, chapterNum]);

  useEffect(() => {
    // Save position every 3 seconds while playing
    if (isPlaying) {
      saveIntervalRef.current = window.setInterval(() => {
        if (audioRef.current) {
          const position = audioRef.current.currentTime;
          localStorage.setItem(getPositionKey(), position.toString());
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

  function savePosition() {
    if (audioRef.current) {
      const position = audioRef.current.currentTime;
      localStorage.setItem(getPositionKey(), position.toString());
    }
  }

  function togglePlayPause() {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  }

  if (loading) {
    return (
      <div style={{ padding: "2rem", textAlign: "center" }}>
        <div>Loading chapter...</div>
      </div>
    );
  }

  if (!chapter) {
    return (
      <div style={{ padding: "2rem", textAlign: "center" }}>
        <h2>Chapter Not Found</h2>
        <Link to={`/audiobooks/${bookId}`} style={{ color: "#8b5cf6", marginTop: "1rem" }}>
          ← Back to Book
        </Link>
      </div>
    );
  }

  return (
    <div style={{ padding: "2rem", maxWidth: "800px", margin: "0 auto" }}>
      {/* Back Button */}
      <Link
        to={`/audiobooks/${bookId}`}
        style={{
          color: "#8b5cf6",
          fontSize: "0.875rem",
          marginBottom: "1.5rem",
          display: "inline-block",
        }}
      >
        ← Back to Book
      </Link>

      {/* Chapter Header */}
      <div style={{ marginBottom: "2rem" }}>
        <h1 style={{ fontSize: "2rem", fontWeight: "600", marginBottom: "0.5rem" }}>
          Chapter {chapter.number}: {chapter.title}
        </h1>
      </div>

      {/* Audio Player */}
      <div
        style={{
          background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
          borderRadius: "16px",
          padding: "2rem",
          marginBottom: "2rem",
          color: "#fff",
          boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
        }}
      >
        {/* Custom Controls */}
        <div
          style={{ display: "flex", alignItems: "center", gap: "1.5rem", marginBottom: "1.5rem" }}
        >
          <button
            onClick={togglePlayPause}
            style={{
              width: "64px",
              height: "64px",
              borderRadius: "50%",
              background: "#fff",
              color: "#667eea",
              border: "none",
              fontSize: "1.5rem",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
              transition: "transform 0.2s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "scale(1.05)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "scale(1)";
            }}
          >
            {isPlaying ? "⏸" : "▶"}
          </button>
          <div style={{ flex: 1 }}>
            <h3 style={{ fontSize: "1.25rem", fontWeight: "600", marginBottom: "0.25rem" }}>
              {chapter.title}
            </h3>
            <p style={{ fontSize: "0.875rem", opacity: 0.9 }}>Chapter {chapter.number}</p>
          </div>
        </div>

        {/* Native Audio Element */}
        <audio
          ref={audioRef}
          src={chapter.audioUrl}
          controls
          style={{
            width: "100%",
            marginBottom: "0.5rem",
          }}
          onPlay={() => setIsPlaying(true)}
          onPause={() => {
            setIsPlaying(false);
            savePosition();
          }}
          onEnded={() => {
            setIsPlaying(false);
            // Clear saved position when chapter completes
            localStorage.removeItem(getPositionKey());
          }}
          onSeeking={savePosition}
        />

        <p style={{ fontSize: "0.75rem", opacity: 0.7, textAlign: "center" }}>
          Use the controls to play, pause, and seek through the chapter
        </p>
      </div>

      {/* Transcript */}
      {chapter.transcript && (
        <div>
          <h2 style={{ fontSize: "1.5rem", fontWeight: "600", marginBottom: "1rem" }}>
            Transcript
          </h2>
          <div
            style={{
              background: "#fff",
              border: "1px solid #e5e7eb",
              borderRadius: "12px",
              padding: "2rem",
              lineHeight: "1.8",
              color: "#374151",
              maxHeight: "600px",
              overflowY: "auto",
            }}
          >
            <ReactMarkdown
              components={{
                h1: ({ children }) => (
                  <h1 style={{ fontSize: "1.875rem", fontWeight: "600", marginBottom: "1rem" }}>
                    {children}
                  </h1>
                ),
                h2: ({ children }) => (
                  <h2
                    style={{
                      fontSize: "1.5rem",
                      fontWeight: "600",
                      marginTop: "1.5rem",
                      marginBottom: "0.75rem",
                    }}
                  >
                    {children}
                  </h2>
                ),
                h3: ({ children }) => (
                  <h3
                    style={{
                      fontSize: "1.25rem",
                      fontWeight: "600",
                      marginTop: "1.25rem",
                      marginBottom: "0.5rem",
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
                    }}
                  >
                    {children}
                  </p>
                ),
                em: ({ children }) => <em style={{ fontStyle: "italic" }}>{children}</em>,
                strong: ({ children }) => <strong style={{ fontWeight: "600" }}>{children}</strong>,
                hr: () => (
                  <hr
                    style={{ margin: "2rem 0", border: "none", borderTop: "1px solid #e5e7eb" }}
                  />
                ),
              }}
            >
              {chapter.transcript}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
