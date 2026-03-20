/**
 * BookDetail — Chapter list for an audiobook
 */

import { useState, useEffect, useMemo } from "react";
import { Link, useRouter, useGatewayClient } from "@anima/ui";

interface Audiobook {
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
    duration?: number;
  }[];
  createdDate: string;
  totalDuration?: number;
}

export function BookDetail() {
  const { params } = useRouter();
  const bookId = useMemo(() => params.bookId as string, [params.bookId]);
  const [book, setBook] = useState<Audiobook | null>(null);
  const [loading, setLoading] = useState(true);
  const { call } = useGatewayClient();

  useEffect(() => {
    async function loadBook() {
      try {
        const result = (await call("audiobooks.get_book", { bookId })) as Audiobook;
        setBook(result);
      } catch (error) {
        console.error("Failed to load book:", error);
      } finally {
        setLoading(false);
      }
    }
    loadBook();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  if (loading) {
    return (
      <div style={{ padding: "2rem", textAlign: "center" }}>
        <div>Loading...</div>
      </div>
    );
  }

  if (!book) {
    return (
      <div style={{ padding: "2rem", textAlign: "center" }}>
        <h2>Book Not Found</h2>
        <Link to="/audiobooks" style={{ color: "#8b5cf6", marginTop: "1rem" }}>
          ← Back to Library
        </Link>
      </div>
    );
  }

  return (
    <div style={{ padding: "1.5rem", maxWidth: "700px", margin: "0 auto" }}>
      {/* Back Button */}
      <Link
        to="/audiobooks"
        style={{
          color: "#8b5cf6",
          fontSize: "0.875rem",
          marginBottom: "1.5rem",
          display: "inline-block",
        }}
      >
        ← Back to Library
      </Link>

      {/* Book Header - Single Column */}
      <div style={{ marginBottom: "2rem" }}>
        {/* Cover - Centered */}
        <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
          <img
            src={`/audiobooks/static/${book.id}/${book.coverImage}`}
            alt={book.title}
            style={{
              width: "100%",
              maxWidth: "280px",
              height: "auto",
              borderRadius: "12px",
              boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
            }}
          />
        </div>

        {/* Book Info - Full Width */}
        <div>
          <h1 style={{ fontSize: "1.875rem", fontWeight: "600", marginBottom: "0.5rem" }}>
            {book.title}
          </h1>
          {book.subtitle && (
            <p style={{ fontSize: "1.125rem", color: "#666", marginBottom: "0.75rem" }}>
              {book.subtitle}
            </p>
          )}
          <p style={{ fontSize: "1rem", color: "#8b5cf6", marginBottom: "1rem" }}>
            by {book.author}
          </p>
          <p style={{ fontSize: "1rem", color: "#444", marginBottom: "1rem", lineHeight: "1.6" }}>
            {book.description}
          </p>

          {/* Tags & Metadata */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "1rem" }}>
            <span
              style={{
                fontSize: "0.875rem",
                background: "#f3f4f6",
                padding: "0.25rem 0.75rem",
                borderRadius: "12px",
                color: "#666",
              }}
            >
              {book.genre}
            </span>
            {book.tags.map((tag) => (
              <span
                key={tag}
                style={{
                  fontSize: "0.875rem",
                  background: "#ede9fe",
                  padding: "0.25rem 0.75rem",
                  borderRadius: "12px",
                  color: "#8b5cf6",
                }}
              >
                {tag}
              </span>
            ))}
          </div>

          <p style={{ fontSize: "0.875rem", color: "#999" }}>
            {book.chapters.length} chapters • {book.createdDate}
          </p>
        </div>
      </div>

      {/* Chapter List */}
      <div>
        <h2 style={{ fontSize: "1.5rem", fontWeight: "600", marginBottom: "1rem" }}>Chapters</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {book.chapters.map((chapter) => (
            <Link
              key={chapter.number}
              to={`/audiobooks/${book.id}/chapter/${chapter.number}`}
              style={{ textDecoration: "none" }}
            >
              <div
                style={{
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: "8px",
                  padding: "1rem",
                  transition: "all 0.2s",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "#8b5cf6";
                  e.currentTarget.style.background = "#faf5ff";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "#e5e7eb";
                  e.currentTarget.style.background = "#fff";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                  <div
                    style={{
                      width: "40px",
                      height: "40px",
                      borderRadius: "50%",
                      background: "#8b5cf6",
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: "600",
                      flexShrink: 0,
                    }}
                  >
                    {chapter.number}
                  </div>
                  <div style={{ flex: 1 }}>
                    <h3
                      style={{
                        fontSize: "1rem",
                        fontWeight: "500",
                        color: "#111",
                        marginBottom: "0.25rem",
                      }}
                    >
                      {chapter.title}
                    </h3>
                    {chapter.duration && (
                      <p style={{ fontSize: "0.875rem", color: "#999" }}>
                        {Math.floor(chapter.duration / 60)} minutes
                      </p>
                    )}
                  </div>
                  <div style={{ color: "#8b5cf6", fontSize: "1.25rem" }}>▶</div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
