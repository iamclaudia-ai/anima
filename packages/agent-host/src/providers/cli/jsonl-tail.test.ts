import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionJsonlTail } from "./jsonl-tail";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "anima-tail-")), "session.jsonl");
}

function nextEvent<T = unknown[]>(
  tail: SessionJsonlTail,
  name: string,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${name}"`)), timeoutMs);
    tail.once(name, (...args: unknown[]) => {
      clearTimeout(t);
      resolve(args as T);
    });
  });
}

function appendLine(file: string, obj: unknown): void {
  appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

describe("SessionJsonlTail", () => {
  test("emits interrupt on a marker appended after start", async () => {
    const file = tmpFile();
    writeFileSync(file, "");
    const tail = new SessionJsonlTail("/x", "s", file);
    const got = nextEvent<[boolean]>(tail, "interrupt");
    tail.start();
    await Bun.sleep(40);
    appendLine(file, {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
      },
      interruptedMessageId: "msg_1",
    });
    const [forToolUse] = await got;
    expect(forToolUse).toBe(true);
    tail.stop();
  });

  test("skips pre-existing history (seeks to EOF)", async () => {
    const file = tmpFile();
    appendLine(file, { type: "user", message: { role: "user", content: "old" } });
    const tail = new SessionJsonlTail("/x", "s", file);
    let sawOld = false;
    tail.on("user_prompt", (t: string) => {
      if (t === "old") sawOld = true;
    });
    const got = nextEvent<[string]>(tail, "user_prompt");
    tail.start();
    await Bun.sleep(40);
    appendLine(file, { type: "user", message: { role: "user", content: "new" } });
    const [text] = await got;
    expect(text).toBe("new");
    expect(sawOld).toBe(false);
    tail.stop();
  });

  test("emits enqueue then dequeue for a steer", async () => {
    const file = tmpFile();
    writeFileSync(file, "");
    const tail = new SessionJsonlTail("/x", "s", file);
    const enq = nextEvent<[string]>(tail, "enqueue");
    const deq = nextEvent(tail, "dequeue");
    tail.start();
    await Bun.sleep(30);
    appendLine(file, { type: "queue-operation", operation: "enqueue", content: "steer" });
    appendLine(file, { type: "queue-operation", operation: "dequeue" });
    const [content] = await enq;
    expect(content).toBe("steer");
    await deq;
    tail.stop();
  });

  test("handles a file that appears after start()", async () => {
    const file = tmpFile();
    // do NOT create the file yet
    const tail = new SessionJsonlTail("/x", "s", file);
    const got = nextEvent<[string]>(tail, "user_prompt");
    tail.start();
    await Bun.sleep(40);
    writeFileSync(file, "");
    await Bun.sleep(40);
    appendLine(file, { type: "user", message: { role: "user", content: "late" } });
    const [text] = await got;
    expect(text).toBe("late");
    tail.stop();
  });
});
