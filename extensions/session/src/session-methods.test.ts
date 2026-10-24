import { describe, expect, it } from "bun:test";
import { sessionMethodDefinitions } from "./session-methods";

function getMethod(name: string) {
  const method = sessionMethodDefinitions.find((entry) => entry.name === name);
  if (!method) {
    throw new Error(`Missing method definition: ${name}`);
  }
  return method;
}

describe("session method execution policies", () => {
  it("classifies read methods onto the parallel read lane", () => {
    expect(getMethod("session.list_workspaces").execution).toEqual({
      lane: "read",
      concurrency: "parallel",
    });
    expect(getMethod("session.list_sessions").execution).toEqual({
      lane: "read",
      concurrency: "parallel",
    });
    expect(getMethod("session.get_workspace").execution).toEqual({
      lane: "read",
      concurrency: "parallel",
    });
  });

  it("accepts a NEW parent and an optional session name on spawn_agent", () => {
    const schema = getMethod("session.spawn_agent").inputSchema;
    expect(
      schema.safeParse({ parentSessionId: "NEW", cwd: "/repo", prompt: "go", name: "Weekly" })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ parentSessionId: "abc", prompt: "go" }).success).toBe(true);
    expect(schema.safeParse({ parentSessionId: "NEW", prompt: "go", name: 7 }).success).toBe(false);
  });

  it("classifies prompts onto the keyed long-running lane", () => {
    expect(getMethod("session.send_prompt").execution).toEqual({
      lane: "long_running",
      concurrency: "keyed",
      keyParam: "sessionId",
    });
  });
});
