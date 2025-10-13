import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Paths
const DB_PATH = path.join(os.homedir(), ".local/state/agent-tts/agent-tts.db");
const TRANSCRIPT_DIR = path.resolve("./transcripts");
if (!fs.existsSync(TRANSCRIPT_DIR)) {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
}

interface Message {
  id: number;
  timestamp: number;
  filename: string;
  profile: string;
  role: string;
  original_text: string;
  images: string | null;
  cwd: string;
}
// Main function
async function main() {
  // Open database
  const db = new Database(DB_PATH, { readonly: true });
  let lastId = 0;
  let lastProject = "";
  let n = 0;

  try {
    fs.rmdirSync(TRANSCRIPT_DIR, { recursive: true });
    while (true) {
      // Get next message (include both 'ara' and 'claudia' profiles for full history)
      const msgs = db
        .prepare(
          `
      SELECT * FROM tts_queue
      WHERE id > ? AND profile = 'claudia'
      ORDER BY timestamp ASC
      LIMIT 100
    `
        )
        .all(lastId) as Message[] | undefined;

      if (!msgs || msgs.length === 0) {
        console.log("\n✅ No new messages to process.\n");
        return;
      }

      console.log(`\n🔄 Processing ${msgs.length} messages...`);
      for (const msg of msgs) {
        // get date for message
        const date = new Date(msg.timestamp).toISOString().split("T")[0];
        let filename = path.join(TRANSCRIPT_DIR, `${date}.md`);

        const message =
          msg.role === "assistant"
            ? getAssistantMessage(msg)
            : getUserMessage(msg);

        let fileSize = 0;
        if (!fs.existsSync(filename)) {
          newFile(filename, msg);
          lastProject = ""; // reset last project for new file
        } else {
          fileSize = fs.statSync(filename).size;
        }

        if (fileSize + message.length > 100 * 1024) {
          // 150KB limit
          console.log(
            `\n⚠️  File size limit reached for ${filename}, split to new file`
          );

          filename = splitFile(filename, msg);
        }
        console.log(`#[${++n}] ${date}`);

        if (msg.cwd !== lastProject) {
          newProject(filename, msg);
          lastProject = msg.cwd;
        }

        fs.appendFileSync(filename, message);
        lastId = msg.id;
      }
    }
  } finally {
    db.close();
  }
}

main().catch(console.error);

function newFile(filename: string, msg: Message) {
  console.log(`\n📝 Creating new file: ${filename}`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(
    filename,
    `# Transcript for ${path.basename(filename, ".md")}\n`
  );
  return filename;
}
function splitFile(filename: string, msg: Message) {
  const basename = path.basename(filename, ".md");
  let newFilename = "";
  if (basename.match(/-part\d+$/)) {
    const part = Number.parseInt(basename.split("-part").pop() || "1", 10) + 1;
    newFilename = path.join(
      TRANSCRIPT_DIR,
      `${basename.replace(/-part\d+$/, "")}-part${part}.md`
    );
  } else {
    newFilename = path.join(TRANSCRIPT_DIR, `${basename}-part2.md`);
  }

  newFile(newFilename, msg);
  newProject(newFilename, msg);
  return newFilename;
}

function newProject(filename: string, msg: Message) {
  console.log(`\n📝 New project in file: ${filename}`);
  fs.appendFileSync(
    filename,
    `\n## Project: ${msg.cwd.replace(os.homedir(), "~")}\n---\n`
  );
}

function getAssistantMessage(msg: Message) {
  return `\n### Assistant\n\n${msg.original_text}\n`;
}

function getUserMessage(msg: Message) {
  return `\n### User\n${msg.original_text}\n`;
}
