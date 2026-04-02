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

  it("classifies prompts onto the keyed long-running lane", () => {
    expect(getMethod("session.send_prompt").execution).toEqual({
      lane: "long_running",
      concurrency: "keyed",
      keyParam: "sessionId",
    });
  });
});
