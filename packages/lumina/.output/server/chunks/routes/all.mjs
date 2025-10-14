import { d as defineEventHandler } from "../../index.mjs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
const VISION_DIR = path.join(os.homedir(), ".claudia/vision");
function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) return text || "";
  return text.substring(0, maxLength) + "...";
}
const all = defineEventHandler(async (event) => {
  const images = [];
  try {
    const dateDirs = await fs.readdir(VISION_DIR);
    for (const dateDir of dateDirs) {
      const datePath = path.join(VISION_DIR, dateDir);
      const stat = await fs.stat(datePath);
      if (!stat.isDirectory()) continue;
      const files = await fs.readdir(datePath);
      const fileGroups = /* @__PURE__ */ new Map();
      for (const file of files) {
        const ext = path.extname(file);
        const baseName = path.basename(file, ext);
        if (!fileGroups.has(baseName)) {
          fileGroups.set(baseName, {});
        }
        const group = fileGroups.get(baseName);
        if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp") {
          group.png = file;
        } else if (ext === ".json") {
          group.json = file;
        }
      }
      for (const [baseName, group] of fileGroups) {
        if (!group.png) continue;
        const imagePath = `/vision/${dateDir}/${group.png}`;
        let metadata;
        if (group.json) {
          try {
            const jsonPath = path.join(datePath, group.json);
            const jsonContent = await fs.readFile(jsonPath, "utf-8");
            metadata = JSON.parse(jsonContent);
          } catch (err) {
            console.error(`Error reading metadata for ${baseName}:`, err);
          }
        }
        images.push({
          filename: baseName,
          path: imagePath,
          title: metadata?.prompt?.substring(0, 50) || baseName,
          timestamp: metadata?.timestamp || dateDir,
          prompt: metadata?.prompt,
          metadata
        });
      }
    }
    images.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    event.node.res.setHeader("Content-Type", "text/html; charset=utf-8");
    event.node.res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>All Images - Lumina</title>
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
    .nav-btn.active { background: white; color: #667eea; border-color: white; }
    .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 2rem; }
    .card {
      background: white;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
      transition: transform 0.3s ease, box-shadow 0.3s ease;
      text-decoration: none;
      color: inherit;
      display: block;
    }
    .card:hover { transform: translateY(-5px); box-shadow: 0 15px 40px rgba(0,0,0,0.3); }
    .card img { width: 100%; height: 300px; object-fit: cover; display: block; }
    .card-info { padding: 1.5rem; }
    .card-title { font-size: 1.2rem; font-weight: 600; margin-bottom: 0.5rem; color: #667eea; }
    .card-date { font-size: 0.9rem; color: #666; margin-bottom: 0.75rem; }
    .card-description { font-size: 0.95rem; color: #555; line-height: 1.5; font-style: italic; }
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
      <a href="/all" class="nav-btn active">All Images</a>
      <a href="/about" class="nav-btn">About</a>
    </nav>

    <div class="gallery">
      ${images.map((img) => `
        <a href="/image/${img.filename}" class="card">
          <img src="${img.path}" alt="${img.prompt || "Art by Claudia"}" />
          <div class="card-info">
            <div class="card-title">${img.title}</div>
            <div class="card-date">${new Date(img.timestamp).toLocaleString()}</div>
            ${img.prompt ? `<div class="card-description">"${truncateText(img.prompt, 120)}"</div>` : ""}
          </div>
        </a>
      `).join("")}
    </div>
  </div>
</body>
</html>`);
  } catch (error) {
    console.error("Error reading vision directory:", error);
    return { error: "Failed to load images" };
  }
});
export {
  all as default
};
