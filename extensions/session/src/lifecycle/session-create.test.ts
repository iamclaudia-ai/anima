import { describe, expect, test } from "bun:test";
import { startTopLevelSession, type TopLevelSessionDeps } from "./session-create";

function recordingDeps() {
  const calls: string[] = [];
  const titles: Array<[string, string]> = [];
  const prompts: Array<Record<string, unknown>> = [];
  const deps: TopLevelSessionDeps = {
    createDraft: (params) => {
      calls.push(`create:${params.cwd}`);
      return { sessionId: "sess-1", agent: params.agent ?? "claude", model: "opus" };
    },
    setTitle: (sessionId, title) => {
      calls.push("title");
      titles.push([sessionId, title]);
    },
    sendPrompt: async (params) => {
      calls.push("prompt");
      prompts.push(params);
    },
  };
  return { deps, calls, titles, prompts };
}

describe("startTopLevelSession", () => {
  test("creates, names, then prompts, in that order", async () => {
    const { deps, calls, titles, prompts } = recordingDeps();
    const result = await startTopLevelSession(
      { cwd: "/repo", prompt: "Run the weekly sweep", name: "Weekly deps" },
      deps,
    );

    expect(calls).toEqual(["create:/repo", "title", "prompt"]);
    expect(titles).toEqual([["sess-1", "Weekly deps"]]);
    expect(prompts).toEqual([
      {
        sessionId: "sess-1",
        content: "Run the weekly sweep",
        cwd: "/repo",
        model: "opus",
        agent: "claude",
      },
    ]);
    expect(result).toEqual({
      sessionId: "sess-1",
      parentSessionId: null,
      agent: "claude",
      cwd: "/repo",
      title: "Weekly deps",
      status: "running",
    });
  });

  test("leaves the title to the prompt fallback when no name is given", async () => {
    const { deps, calls } = recordingDeps();
    const result = await startTopLevelSession({ cwd: "/repo", prompt: "hi", name: "   " }, deps);
    expect(calls).toEqual(["create:/repo", "prompt"]);
    expect(result.title).toBeNull();
  });

  test("passes the agent through to both create and prompt", async () => {
    const { deps, prompts } = recordingDeps();
    await startTopLevelSession({ cwd: "/repo", prompt: "review", agent: "codex" }, deps);
    expect(prompts[0]?.agent).toBe("codex");
  });

  test("requires a cwd, since there is no parent to inherit one from", async () => {
    const { deps, calls } = recordingDeps();
    await expect(startTopLevelSession({ prompt: "hi" }, deps)).rejects.toThrow(
      'cwd is required when parentSessionId is "NEW"',
    );
    expect(calls).toEqual([]);
  });
});
