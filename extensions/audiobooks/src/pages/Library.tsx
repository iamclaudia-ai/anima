/**
 * Library — Audiobooks grid view
 */

import { useState, useEffect } from "react";
import { Link, useGatewayClient } from "@claudia/ui";

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
  }[];
  createdDate: string;
}

export function Library() {
  const [books, setBooks] = useState<Audiobook[]>([]);
  const [loading, setLoading] = useState(true);
  const { call } = useGatewayClient();

  useEffect(() => {
    async function loadBooks() {
      try {
        const result = (await call("audiobooks.get_books", {})) as Audiobook[];
        setBooks(result);
      } catch (error) {
        console.error("[Library] Failed to load audiobooks:", error);
      } finally {
        setLoading(false);
      }
    }
    loadBooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div style={{ padding: "2rem", textAlign: "center" }}>
        <div>Loading audiobooks...</div>
      </div>
    );
  }

  if (books.length === 0) {
    return (
      <div style={{ padding: "2rem", textAlign: "center" }}>
        <h2>No Audiobooks Found</h2>
        <p style={{ color: "#666", marginTop: "0.5rem" }}>
          Add audiobooks to ~/romance-novels with metadata.json files
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: "2rem", maxWidth: "1200px", margin: "0 auto" }}>
      <h1 style={{ marginBottom: "2rem", fontSize: "2rem", fontWeight: "600" }}>Audiobooks 🎧</h1>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: "2rem",
        }}
      >
        {books.map((book) => (
          <Link key={book.id} to={`/audiobooks/${book.id}`} style={{ textDecoration: "none" }}>
            <div
              style={{
                background: "#fff",
                borderRadius: "12px",
                overflow: "hidden",
                boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                transition: "transform 0.2s, box-shadow 0.2s",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = "translateY(-4px)";
                e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.15)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = "translateY(0)";
                e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.1)";
              }}
            >
              {/* Cover Image */}
              <div style={{ aspectRatio: "2/3", position: "relative", overflow: "hidden" }}>
                <img
                  src={`/audiobooks/static/${book.id}/${book.coverImage}`}
                  alt={book.title}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              </div>

              {/* Book Info */}
              <div style={{ padding: "1rem" }}>
                <h3
                  style={{
                    fontSize: "1.125rem",
                    fontWeight: "600",
                    marginBottom: "0.25rem",
                    color: "#111",
                  }}
                >
                  {book.title}
                </h3>
                {book.subtitle && (
                  <p style={{ fontSize: "0.875rem", color: "#666", marginBottom: "0.5rem" }}>
                    {book.subtitle}
                  </p>
                )}
                <p style={{ fontSize: "0.875rem", color: "#8b5cf6", marginBottom: "0.5rem" }}>
                  by {book.author}
                </p>
                <p
                  style={{
                    fontSize: "0.875rem",
                    color: "#666",
                    marginBottom: "0.75rem",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {book.description}
                </p>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span
                    style={{
                      fontSize: "0.75rem",
                      background: "#f3f4f6",
                      padding: "0.25rem 0.5rem",
                      borderRadius: "4px",
                      color: "#666",
                    }}
                  >
                    {book.genre}
                  </span>
                  <span
                    style={{
                      fontSize: "0.75rem",
                      color: "#999",
                    }}
                  >
                    {book.chapters.length} chapters
                  </span>
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
