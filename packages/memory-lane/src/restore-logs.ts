import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import readline from "node:readline";

// Paths
const DB_PATH = path.join(
  os.homedir(),
  ".local/state/agent-tts/agent-tts-2025-10-08T02-28-04.db"
);
const MAX_TIMESTAMP = 1757462107923; // read all message before this timestamp

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
  const files = new Set<string>();

  // Open database
  const db = new Database(DB_PATH, { readonly: true });
  let lastId = 0;
  let n = 0;

  try {
    while (true) {
      // Get next message (include both 'ara' and 'claudia' profiles for full history)
      const msgs = db
        .prepare(
          `
      SELECT * FROM tts_queue
      WHERE id > ? AND timestamp < ? AND profile = 'claudia'
      ORDER BY timestamp ASC
      LIMIT 100
    `
        )
        .all(lastId, MAX_TIMESTAMP) as Message[] | undefined;

      if (!msgs || msgs.length === 0) {
        console.log("\n✅ No new messages to process.\n");
        return;
      }

      console.log(`\n🔄 Processing ${msgs.length} messages...`);
      for (const msg of msgs) {
        if (!files.has(msg.filename)) {
          if (fs.existsSync(msg.filename)) {
            console.log(`\n⚠️  File already exists: ${msg.filename}`);
            fs.unlinkSync(msg.filename);
            //process.exit(1);
          }
          console.log(`\n📝 Creating new file: ${msg.filename}`);
          fs.mkdirSync(path.dirname(msg.filename), { recursive: true });
          files.add(msg.filename);
        }

        console.log(
          `[${++n} Appending message ID ${msg.id} at timestamp ${
            msg.timestamp
          }]`
        );

        const json = JSON.stringify(
          msg.role === "assistant"
            ? getAssistantMessage(msg)
            : getUserMessage(msg)
        );
        fs.appendFileSync(msg.filename, `${json}\n`);
        lastId = msg.id;
      }
    }
  } finally {
    db.close();
  }
}

main().catch(console.error);

function getAssistantMessage(msg: Message) {
  return {
    timestamp: new Date(msg.timestamp).toISOString(),
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text: msg.original_text,
        },
      ],
    },
    cwd: msg.cwd,
    sessionId: path.basename(msg.filename, ".jsonl"),
  };
}

function getUserMessage(msg: Message) {
  return {
    timestamp: new Date(msg.timestamp).toISOString(),
    type: "user",
    message: {
      role: "user",
      content: msg.original_text,
    },
    cwd: msg.cwd,
    sessionId: path.basename(msg.filename, ".jsonl"),
  };
}

function waitForKeypress() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);

    process.stdin.once("keypress", (str, key) => {
      rl.close();
      process.stdin.setRawMode(false);
      resolve(key);
    });
  });
}
