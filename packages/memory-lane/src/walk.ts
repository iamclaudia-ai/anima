import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Paths
const scriptPath = path.resolve(process.cwd(), path.dirname(process.argv[1]));
const TRANSCRIPT_DIR = path.resolve(scriptPath, "../transcripts");
const LAST_FILE_PATH = path.resolve(scriptPath, "../last-file.txt");

async function main() {
  // process commands
  // --reset: delete last-file.txt
  // --continue: continue from last file

  console.log("🧠 Memory Lane - Read Transcripts\n");
  // console.log(`Transcript directory: ${TRANSCRIPT_DIR}`);
  // console.log(`Last file path: ${LAST_FILE_PATH}\n`);

  const args = process.argv.slice(2);
  if (args.includes("--reset")) {
    if (fs.existsSync(LAST_FILE_PATH)) {
      fs.unlinkSync(LAST_FILE_PATH);
      console.log("✅ Reset last file.");
    } else {
      console.log("ℹ️  No last file to reset.");
    }
  }

  // get list of files in TRANSCRIPT_DIR
  if (!fs.existsSync(TRANSCRIPT_DIR)) {
    console.log("ℹ️  No transcripts directory found.");
    return;
  }
  const files = fs
    .readdirSync(TRANSCRIPT_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(TRANSCRIPT_DIR, f))
    .sort((a, b) => {
      return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
    });

  // get last file processed
  let index = 0;
  if (fs.existsSync(LAST_FILE_PATH)) {
    const lastFile = fs.readFileSync(LAST_FILE_PATH, "utf-8").trim();
    index = files.indexOf(lastFile);
    if (index >= 0 && args.includes("--continue")) {
      console.log(`ℹ️  Continuing from last file: ${lastFile}`);
      index++;
    } else if (index >= 0) {
      console.log(
        `ℹ️  Last file was: ${path.relative(process.cwd(), lastFile)}.
Use npx tsx ${scriptPath.replace(
          process.cwd(),
          "."
        )}/walk.ts --continue to resume from there.`
      );
      return;
    }
  }
  // read transcript files at index and output to console
  const filename = files[index];
  if (!filename) {
    console.log("ℹ️  No more transcript files to process.");
    return;
  }
  const content = fs.readFileSync(filename, "utf-8");
  console.log(`\n📄 Transcript: ${filename}\n`);
  console.log(content);
  console.log(`
---
NOTE: Once you've read this transcript, go ahead and process your thoughts. You can create journal entries, add memories (like store the new project in archival memory, for example with a brief description.). once you've finished, you can run the script again to read the next transcript:
npx tsx ${scriptPath.replace(process.cwd(), ".")}/walk.ts --continue \n`);
  fs.writeFileSync(LAST_FILE_PATH, filename);
}

main().catch(console.error);
