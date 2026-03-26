export interface MemoryContextResult {
  recentMessages: Array<{ role: string; content: string; timestamp: string }>;
  recentSummaries: Array<{ summary: string; firstMessageAt: string; lastMessageAt: string }>;
}

export function formatMemoryContext(memory: MemoryContextResult): string | null {
  if (memory.recentMessages.length === 0 && memory.recentSummaries.length === 0) return null;

  const parts: string[] = [
    "<claudia_memory_context>",
    "This is your automatically injected memory context for session continuity.",
    "It contains a snapshot of the most recent conversation and summaries of recent past sessions in this workspace.",
    "Use this to maintain continuity — you should know what Michael was working on and pick up naturally.",
    "Do NOT recite this context back unless asked. Just be aware of it.",
    "",
  ];

  if (memory.recentMessages.length > 0) {
    parts.push("## Last Conversation (most recent messages before this session)");
    parts.push(
      "These are the final messages from the immediately preceding session. This is what you and Michael were just doing:\n",
    );
    for (const msg of memory.recentMessages) {
      const time = new Date(msg.timestamp).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      const name = msg.role === "user" ? "Michael" : "Claudia";
      const content = msg.content.length > 500 ? msg.content.slice(0, 500) + "..." : msg.content;
      parts.push(`[${time}] ${name}: ${content}`);
    }
  }

  if (memory.recentSummaries.length > 0) {
    parts.push("\n## Recent Session Summaries (chronological, oldest first)");
    parts.push(
      "These are Libby's summaries of your recent archived conversations in this workspace:\n",
    );
    for (const summary of memory.recentSummaries) {
      const date = new Date(summary.firstMessageAt).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      parts.push(`- [${date}] ${summary.summary}`);
    }
  }

  parts.push("</claudia_memory_context>");
  return parts.join("\n");
}
