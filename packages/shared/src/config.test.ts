import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearConfigCache,
  getEnabledExtensions,
  getExtensionConfig,
  isExtensionEnabled,
  loadConfig,
} from "./config";

describe("config loader", () => {
  let tempDir = "";
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claudia-config-test-"));
    envBackup = { ...process.env };
    clearConfigCache();
  });

  afterEach(() => {
    process.env = envBackup;
    clearConfigCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads JSON5 config file and interpolates env vars", () => {
    const configPath = join(tempDir, "claudia.json");
    process.env.TEST_ENDPOINT = "gateway.example.com";
    process.env.TEST_MODEL = "claude-opus";

    writeFileSync(
      configPath,
      `{
        gateway: {
          port: 40001,
          endpoint: "\${TEST_ENDPOINT}",
        },
        session: {
          model: "\${TEST_MODEL}",
          thinking: true,
          effort: "high",
        },
        extensions: {
          hooks: { enabled: true, config: { dir: "/hooks" } },
        },
      }`,
      "utf-8",
    );

    const config = loadConfig(configPath);
    expect(config.gateway.port).toBe(40001);
    expect(config.gateway.endpoint).toBe("gateway.example.com");
    expect(config.gateway.host).toBe("localhost");
    expect(config.session.model).toBe("claude-opus");
    expect(config.session.thinking).toBe(true);
    expect(config.session.effort).toBe("high");
    expect(config.extensions.hooks?.enabled).toBe(true);
  });

  it("throws when no config file exists", () => {
    const missingPath = join(tempDir, "missing.json");
    process.env.CLAUDIA_HOME = tempDir;
    delete process.env.CLAUDIA_CONFIG;
    expect(() => loadConfig(missingPath)).toThrow("No config file found");
  });

  it("handles missing interpolated env vars and parse errors gracefully", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const badPath = join(tempDir, "bad.json");
    writeFileSync(badPath, "{ invalid json", "utf-8");

    expect(() => loadConfig(badPath)).toThrow("Error parsing");

    // Missing env interpolation warning path
    clearConfigCache();
    const goodPath = join(tempDir, "good.json");
    writeFileSync(
      goodPath,
      `{
        gateway: { endpoint: "\${UNSET_ENV}" },
      }`,
      "utf-8",
    );
    const interpolated = loadConfig(goodPath);
    expect(interpolated.gateway.endpoint).toBe("");
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("caches loadConfig and supports extension helper APIs", () => {
    const configPath = join(tempDir, "claudia.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extensions: {
          a: { enabled: true, config: { x: 1 } },
          b: { enabled: false, config: { y: 2 } },
        },
      }),
      "utf-8",
    );

    const first = loadConfig(configPath);
    const second = loadConfig();
    expect(second).toBe(first); // cached when no explicit path provided

    expect(getExtensionConfig("a")).toEqual({ enabled: true, config: { x: 1 } });
    expect(getExtensionConfig("missing")).toBeUndefined();
    expect(isExtensionEnabled("a")).toBe(true);
    expect(isExtensionEnabled("b")).toBe(false);
    expect(getEnabledExtensions()).toEqual([["a", { enabled: true, config: { x: 1 } }]]);
  });

  it("loads additive session skill paths from config", () => {
    const configPath = join(tempDir, "claudia.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        session: {
          skills: {
            paths: ["~/.claudia/skills", ".claudia/skills", "/tmp/custom-skills"],
          },
        },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.session.skills.paths).toEqual([
      "~/.claudia/skills",
      ".claudia/skills",
      "/tmp/custom-skills",
    ]);
  });
});
