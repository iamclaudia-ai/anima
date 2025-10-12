import { d as defineEventHandler } from "../../../index.mjs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
const VISION_DIR = path.join(os.homedir(), ".claudia/vision");
const images = defineEventHandler(async () => {
  try {
    const images2 = [];
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
        images2.push({
          path: imagePath,
          title: metadata?.prompt?.substring(0, 50) || baseName,
          timestamp: metadata?.timestamp || dateDir,
          prompt: metadata?.prompt,
          backend: metadata?.backend,
          metadata
        });
      }
    }
    images2.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return images2;
  } catch (error) {
    console.error("Error reading vision directory:", error);
    return [];
  }
});
export {
  images as default
};
