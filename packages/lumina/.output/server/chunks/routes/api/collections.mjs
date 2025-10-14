import { d as defineEventHandler } from "../../../index.mjs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
const COLLECTIONS_DIR = path.join(os.homedir(), ".claudia/wings/collections");
async function parseCollectionMarkdown(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");
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
const collections = defineEventHandler(async () => {
  try {
    const collections2 = [];
    const files = await fs.readdir(COLLECTIONS_DIR);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = path.join(COLLECTIONS_DIR, file);
      const collection = await parseCollectionMarkdown(filePath);
      if (collection) {
        collections2.push(collection);
      }
    }
    collections2.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
    return collections2;
  } catch (error) {
    console.error("Error reading collections directory:", error);
    return [];
  }
});
export {
  collections as default
};
