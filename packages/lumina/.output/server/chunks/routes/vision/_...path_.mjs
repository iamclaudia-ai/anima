import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
const VISION_DIR = path.join(os.homedir(), ".claudia/vision");
const ____path_ = defineEventHandler(async (event) => {
  const params = event.context.params?.path;
  if (!params) {
    throw createError({
      statusCode: 400,
      statusMessage: "Path parameter is required"
    });
  }
  const filePath = path.join(VISION_DIR, params);
  const resolvedPath = path.resolve(filePath);
  const resolvedVisionDir = path.resolve(VISION_DIR);
  if (!resolvedPath.startsWith(resolvedVisionDir)) {
    throw createError({
      statusCode: 403,
      statusMessage: "Access denied"
    });
  }
  try {
    const fileBuffer = await fs.readFile(resolvedPath);
    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".json": "application/json"
    }[ext] || "application/octet-stream";
    event.node.res.setHeader("Content-Type", contentType);
    event.node.res.setHeader("Cache-Control", "public, max-age=31536000");
    return fileBuffer;
  } catch (error) {
    throw createError({
      statusCode: 404,
      statusMessage: "File not found"
    });
  }
});
export {
  ____path_ as default
};
