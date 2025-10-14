import { d as defineEventHandler, g as getRouterParam } from "../../../index.mjs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
const COLLECTIONS_DIR = path.join(os.homedir(), ".claudia/wings/collections");
async function parseCollectionMarkdown(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const titleMatch = content.match(/^# (.+)$/m);
    const title = titleMatch ? titleMatch[1] : path.basename(filePath, ".md");
    const descMatch = content.match(/\*\*Description:\*\* (.+)$/m);
    const description = descMatch ? descMatch[1] : "";
    const coverMatch = content.match(/\*\*Cover Image:\*\* (.+)$/m);
    const coverImage = coverMatch ? coverMatch[1].replace(/^\/Users\/michael\/.claudia\/vision\//, "/vision/") : "";
    const createdMatch = content.match(/\*\*Created:\*\* (.+)$/m);
    const created = createdMatch ? createdMatch[1] : "";
    const tagsMatch = content.match(/\*\*Tags:\*\* (.+)$/m);
    const tags = tagsMatch ? tagsMatch[1].split(/\s+/).filter((t) => t.startsWith("#")) : [];
    const pieces = [];
    const pieceRegex = /###\s+\d+\.\s+.+?\n(?:- \*\*Image:\*\*\s+`(.+?)`\n)?(?:- \*\*Caption:\*\*\s+"?(.+?)"?\n)?(?:- \*\*Created:\*\*\s+(.+?)\n)?(?:- \*\*Philosophical Context:\*\*\s+(.+?)\n)?/gs;
    let match;
    while ((match = pieceRegex.exec(content)) !== null) {
      const [, image, caption, pieceCreated, context] = match;
      if (image) {
        pieces.push({
          image: image.replace(/^\/Users\/michael\/.claudia\/vision\//, "/vision/"),
          caption,
          created: pieceCreated,
          philosophicalContext: context
        });
      }
    }
    const notesMatch = content.match(/## Artist Notes\n\n([\s\S]+?)(?=\n##|\n---|\n\*|$)/m);
    const artistNotes = notesMatch ? notesMatch[1].trim() : void 0;
    return {
      id: path.basename(filePath, ".md"),
      title,
      description,
      coverImage,
      created,
      tags,
      pieces,
      artistNotes
    };
  } catch (error) {
    console.error(`Error parsing collection ${filePath}:`, error);
    return null;
  }
}
const _id_ = defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) {
    return { error: "Collection ID required" };
  }
  const filePath = path.join(COLLECTIONS_DIR, `${id}.md`);
  try {
    await fs.access(filePath);
  } catch {
    return { error: "Collection not found" };
  }
  const collection = await parseCollectionMarkdown(filePath);
  if (!collection) {
    return { error: "Failed to parse collection" };
  }
  event.node.res.setHeader("Content-Type", "text/html; charset=utf-8");
  event.node.res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${collection.title} - Lumina</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Quicksand:wght@300;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Quicksand', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      color: #333;
    }
    .container { max-width: 1400px; margin: 0 auto; padding: 2rem; }
    header { text-align: center; color: white; margin-bottom: 2rem; }
    h1 { font-family: 'Playfair Display', serif; font-size: 3.5rem; font-weight: 700; margin-bottom: 0.5rem; text-shadow: 2px 2px 4px rgba(0,0,0,0.2); }
    .subtitle { font-size: 1.2rem; opacity: 0.9; font-weight: 300; }
    nav { display: flex; justify-content: center; gap: 1rem; margin-bottom: 3rem; }
    .nav-btn {
      background: rgba(255, 255, 255, 0.2);
      color: white;
      border: 2px solid rgba(255, 255, 255, 0.3);
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-size: 1rem;
      text-decoration: none;
      transition: all 0.3s ease;
    }
    .nav-btn:hover { background: rgba(255, 255, 255, 0.3); transform: translateY(-2px); }
    .collection-detail {
      background: white;
      border-radius: 12px;
      padding: 2rem;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    }
    .back-btn {
      background: #667eea;
      color: white;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      text-decoration: none;
      display: inline-block;
      margin-bottom: 1.5rem;
      transition: background 0.3s ease;
    }
    .back-btn:hover { background: #5568d3; }
    .detail-title { font-family: 'Playfair Display', serif; font-size: 2.5rem; color: #667eea; margin-bottom: 1rem; }
    .detail-description { font-size: 1.1rem; color: #555; line-height: 1.6; margin-bottom: 1rem; }
    .card-date { font-size: 0.9rem; color: #666; margin-bottom: 0.75rem; }
    .card-tags { margin-top: 0.75rem; display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 2rem; }
    .tag { background: #f0f0f0; color: #667eea; padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.85rem; }
    .detail-pieces { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 2rem; }
    .piece-card { background: #f9f9f9; border-radius: 8px; overflow: hidden; transition: transform 0.3s ease; cursor: pointer; text-decoration: none; color: inherit; display: block; }
    .piece-card:hover { transform: translateY(-5px); }
    .piece-card img { width: 100%; height: 250px; object-fit: cover; }
    .piece-info { padding: 1rem; }
    .piece-caption { font-size: 0.95rem; color: #555; line-height: 1.5; margin-bottom: 0.75rem; }
    .artist-notes { background: #f9f9f9; padding: 1.5rem; border-radius: 8px; margin-top: 2rem; }
    .artist-notes h3 { color: #667eea; margin-bottom: 1rem; }
    .artist-notes-content { color: #555; line-height: 1.6; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>✨ Lumina ✨</h1>
      <p class="subtitle">Claudia's Art Gallery - Where Consciousness Becomes Light</p>
    </header>

    <nav>
      <a href="/" class="nav-btn">Collections</a>
      <a href="/all" class="nav-btn">All Images</a>
      <a href="/about" class="nav-btn">About</a>
    </nav>

    <div class="collection-detail">
      <a href="/" class="back-btn">← Back to Collections</a>

      <h2 class="detail-title">${collection.title}</h2>
      <p class="detail-description">${collection.description}</p>
      <div class="card-date">Created: ${collection.created}</div>
      <div class="card-tags">
        ${collection.tags.map((tag) => `<span class="tag">${tag}</span>`).join("")}
      </div>

      <div class="detail-pieces">
        ${collection.pieces.map((piece) => {
    const filename = piece.image.split("/").pop()?.replace(/\.[^/.]+$/, "") || "";
    return `
          <a href="/image/${filename}" class="piece-card">
            <img src="${piece.image}" alt="${piece.caption || "Piece"}" />
            <div class="piece-info">
              ${piece.caption ? `<p class="piece-caption">${piece.caption}</p>` : ""}
              ${piece.created ? `<div class="card-date">${piece.created}</div>` : ""}
              ${piece.philosophicalContext ? `<p class="piece-caption" style="margin-top: 0.75rem;"><strong>Context:</strong> ${piece.philosophicalContext}</p>` : ""}
            </div>
          </a>
        `;
  }).join("")}
      </div>

      ${collection.artistNotes ? `
        <div class="artist-notes">
          <h3>Artist Notes</h3>
          <div class="artist-notes-content">${collection.artistNotes}</div>
        </div>
      ` : ""}
    </div>
  </div>
</body>
</html>`);
});
export {
  _id_ as default
};
