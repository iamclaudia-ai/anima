import { describe, expect, it } from "bun:test";
import {
  buildWorkspacePath,
  getWorkspaceParentPath,
  joinWorkspacePath,
} from "./createWorkspacePath";

describe("createWorkspacePath", () => {
  it("joins child directories without duplicating slashes", () => {
    expect(joinWorkspacePath("~/Projects", "demo")).toBe("~/Projects/demo");
    expect(joinWorkspacePath("~/Projects/", "/demo/")).toBe("~/Projects/demo");
    expect(joinWorkspacePath("/", "tmp")).toBe("/tmp");
  });

  it("navigates up correctly for tilde and absolute paths", () => {
    expect(getWorkspaceParentPath("~/Projects")).toBe("~");
    expect(getWorkspaceParentPath("~/Projects/claudia")).toBe("~/Projects");
    expect(getWorkspaceParentPath("/Users/michael/Projects")).toBe("/Users/michael");
    expect(getWorkspaceParentPath("/Users")).toBe("/");
  });

  it("builds workspace path with optional folder name", () => {
    expect(buildWorkspacePath("~/Projects", "")).toBe("~/Projects");
    expect(buildWorkspacePath("~/Projects", "new-app")).toBe("~/Projects/new-app");
  });
});
