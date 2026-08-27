import { describe, expect, test } from "bun:test";
import { animaSessionEnv, animaSessionEnvWithProcess } from "./anima-env";

describe("animaSessionEnv", () => {
  test("exports the session id the CLI auto-injects from", () => {
    expect(animaSessionEnv("ses_abc")).toEqual({ ANIMA_SESSION_ID: "ses_abc" });
  });
});

describe("animaSessionEnvWithProcess", () => {
  test("carries process.env through for spawn APIs that replace it", () => {
    const env = animaSessionEnvWithProcess("ses_abc");
    expect(env.ANIMA_SESSION_ID).toBe("ses_abc");
    expect(env.PATH).toBe(process.env.PATH!);
  });

  test("applies overrides but never lets one clobber the session id", () => {
    const env = animaSessionEnvWithProcess("ses_abc", {
      CLAUDECODE: "",
      ANIMA_SESSION_ID: "stale",
    });
    expect(env.CLAUDECODE).toBe("");
    expect(env.ANIMA_SESSION_ID).toBe("ses_abc");
  });

  test("drops undefined process.env entries rather than passing them on", () => {
    const env = animaSessionEnvWithProcess("ses_abc");
    expect(Object.values(env).every((v) => typeof v === "string")).toBe(true);
  });
});
