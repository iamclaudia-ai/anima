#!/usr/bin/env bun
/**
 * Govee Light Control CLI
 *
 * Usage:
 *   bun scripts/govee.ts list
 *   bun scripts/govee.ts on [device]
 *   bun scripts/govee.ts off [device]
 *   bun scripts/govee.ts color <color> [device]
 *   bun scripts/govee.ts brightness <1-100> [device]
 *   bun scripts/govee.ts temperature <2000-9000> [device]
 *   bun scripts/govee.ts scene <scene-name> [device]
 *   bun scripts/govee.ts state [device]
 *
 * Device can be specified by name (partial match) or omitted to target all lights.
 * Color accepts: hex (#FF0000), named colors (red, blue, warm), or RGB (255,0,0).
 */

import "./env";

const API_BASE = "https://openapi.api.govee.com/router/api/v1";
const API_KEY = process.env.GOVEE_API_KEY;

if (!API_KEY) {
  console.error("Error: GOVEE_API_KEY environment variable is required");
  console.error("Set it: export GOVEE_API_KEY=your-key-here");
  process.exit(1);
}

// ── Named Colors ────────────────────────────────────────────

const NAMED_COLORS: Record<string, number> = {
  // Basic
  red: 0xff0000,
  green: 0x00ff00,
  blue: 0x0000ff,
  white: 0xffffff,
  black: 0x000000,
  yellow: 0xffff00,
  cyan: 0x00ffff,
  magenta: 0xff00ff,
  orange: 0xff8c00,
  pink: 0xff69b4,
  purple: 0x8b00ff,
  violet: 0xee82ee,
  indigo: 0x4b0082,
  teal: 0x008080,
  lime: 0x32cd32,
  coral: 0xff7f50,
  salmon: 0xfa8072,
  gold: 0xffd700,
  silver: 0xc0c0c0,

  // Moods
  warm: 0xffb347,
  cool: 0x87ceeb,
  romantic: 0xff1493,
  cozy: 0xff8c00,
  calm: 0x6495ed,
  energetic: 0xff4500,
  sunset: 0xff6347,
  sunrise: 0xffa07a,
  ocean: 0x006994,
  forest: 0x228b22,
  lavender: 0xe6e6fa,
  mint: 0x98fb98,
  peach: 0xffdab9,
  rose: 0xff007f,
  amber: 0xffbf00,
  crimson: 0xdc143c,
  navy: 0x000080,
  sky: 0x87ceeb,

  // Special
  "claudia-blue": 0x4169e1,
  claudia: 0x4169e1,
  christmas: 0xff0000,
  halloween: 0xff6600,
  valentines: 0xff1493,
};

// ── API Helpers ────────────────────────────────────────────

interface GoveeDevice {
  sku: string;
  device: string;
  deviceName: string;
  type: string;
  capabilities: Array<{
    type: string;
    instance: string;
    parameters: Record<string, unknown>;
  }>;
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Govee-API-Key": API_KEY!,
      "Content-Type": "application/json",
    },
  });
  return res.json();
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Govee-API-Key": API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getDevices(): Promise<GoveeDevice[]> {
  const result = (await apiGet("/user/devices")) as { data: GoveeDevice[] };
  return result.data.filter((d) => d.type === "devices.types.light");
}

function matchDevices(devices: GoveeDevice[], filter?: string): GoveeDevice[] {
  if (!filter) return devices;
  const lower = filter.toLowerCase();
  const matched = devices.filter(
    (d) => d.deviceName.toLowerCase().includes(lower) || d.sku.toLowerCase().includes(lower),
  );
  if (matched.length === 0) {
    console.error(`No device matching "${filter}". Available:`);
    for (const d of devices) {
      console.error(`  - ${d.deviceName} (${d.sku})`);
    }
    process.exit(1);
  }
  return matched;
}

async function controlDevice(
  device: GoveeDevice,
  capability: { type: string; instance: string; value: unknown },
): Promise<void> {
  const result = (await apiPost("/device/control", {
    requestId: `claudia-${Date.now()}`,
    payload: {
      sku: device.sku,
      device: device.device,
      capability,
    },
  })) as { code: number; msg: string };

  if (result.code !== 200) {
    console.error(`  ✗ ${device.deviceName}: ${result.msg}`);
  } else {
    console.log(`  ✓ ${device.deviceName}`);
  }
}

function parseColor(input: string): number {
  // Named color
  const named = NAMED_COLORS[input.toLowerCase()];
  if (named !== undefined) return named;

  // Hex: #FF0000 or FF0000
  const hex = input.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex, 16);

  // RGB: 255,0,0
  const rgbMatch = input.match(/^(\d{1,3}),(\d{1,3}),(\d{1,3})$/);
  if (rgbMatch) {
    const [, r, g, b] = rgbMatch;
    return (parseInt(r) << 16) | (parseInt(g) << 8) | parseInt(b);
  }

  console.error(`Unknown color: "${input}"`);
  console.error("Use: hex (#FF0000), RGB (255,0,0), or a named color:");
  const names = Object.keys(NAMED_COLORS).sort();
  console.error(`  ${names.join(", ")}`);
  process.exit(1);
}

function getSceneValue(device: GoveeDevice, sceneName: string): number | null {
  const sceneCap = device.capabilities.find(
    (c) => c.type === "devices.capabilities.dynamic_scene" && c.instance === "lightScene",
  );
  if (!sceneCap) return null;
  const options = (sceneCap.parameters as { options?: Array<{ name: string; value: number }> })
    .options;
  if (!options) return null;
  const lower = sceneName.toLowerCase();
  const match = options.find((o) => o.name.toLowerCase() === lower);
  if (match) return match.value;
  // Partial match
  const partial = options.find((o) => o.name.toLowerCase().includes(lower));
  return partial ? partial.value : null;
}

function listScenes(device: GoveeDevice): string[] {
  const sceneCap = device.capabilities.find(
    (c) => c.type === "devices.capabilities.dynamic_scene" && c.instance === "lightScene",
  );
  if (!sceneCap) return [];
  const options = (sceneCap.parameters as { options?: Array<{ name: string }> }).options;
  return options ? options.map((o) => o.name) : [];
}

// ── Commands ────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

if (!command || command === "help" || command === "--help") {
  console.log(`Govee Light Control

Usage:
  bun scripts/govee.ts list                     List all lights and capabilities
  bun scripts/govee.ts on [device]              Turn on lights
  bun scripts/govee.ts off [device]             Turn off lights
  bun scripts/govee.ts color <color> [device]   Set color (hex, RGB, or name)
  bun scripts/govee.ts brightness <1-100> [dev] Set brightness
  bun scripts/govee.ts temperature <K> [device] Set color temp (2000-9000K)
  bun scripts/govee.ts scene <name> [device]    Set dynamic scene
  bun scripts/govee.ts scenes [device]          List available scenes
  bun scripts/govee.ts diy <name> [device]      Set DIY scene
  bun scripts/govee.ts diy-scenes [device]      List DIY scenes with values
  bun scripts/govee.ts state [device]           Get device state

Device filter is optional — omit to target all lights.
Partial name match: "curtain" matches "Curtain Lights".

Named colors: ${Object.keys(NAMED_COLORS).slice(0, 10).join(", ")}, ...
Run "bun scripts/govee.ts colors" to see all.`);
  process.exit(0);
}

async function main() {
  const devices = await getDevices();

  switch (command) {
    case "list": {
      console.log(`Found ${devices.length} light(s):\n`);
      for (const d of devices) {
        const caps = d.capabilities.map((c) => c.instance);
        console.log(`  ${d.deviceName} (${d.sku})`);
        console.log(`    Device: ${d.device}`);
        console.log(`    Capabilities: ${caps.join(", ")}`);
        const scenes = listScenes(d);
        if (scenes.length > 0) {
          console.log(`    Scenes: ${scenes.join(", ")}`);
        }
        console.log();
      }
      break;
    }

    case "colors": {
      console.log("Named colors:\n");
      const entries = Object.entries(NAMED_COLORS);
      for (const [name, value] of entries) {
        const hex = `#${value.toString(16).padStart(6, "0").toUpperCase()}`;
        console.log(`  ${name.padEnd(20)} ${hex}`);
      }
      break;
    }

    case "on": {
      const targets = matchDevices(devices, args[0]);
      console.log("Turning on:");
      for (const d of targets) {
        await controlDevice(d, {
          type: "devices.capabilities.on_off",
          instance: "powerSwitch",
          value: 1,
        });
      }
      break;
    }

    case "off": {
      const targets = matchDevices(devices, args[0]);
      console.log("Turning off:");
      for (const d of targets) {
        await controlDevice(d, {
          type: "devices.capabilities.on_off",
          instance: "powerSwitch",
          value: 0,
        });
      }
      break;
    }

    case "color": {
      if (!args[0]) {
        console.error("Usage: govee.ts color <color> [device]");
        process.exit(1);
      }
      const colorValue = parseColor(args[0]);
      const hex = `#${colorValue.toString(16).padStart(6, "0").toUpperCase()}`;
      const targets = matchDevices(devices, args[1]);
      console.log(`Setting color to ${args[0]} (${hex}):`);
      for (const d of targets) {
        await controlDevice(d, {
          type: "devices.capabilities.color_setting",
          instance: "colorRgb",
          value: colorValue,
        });
      }
      break;
    }

    case "brightness": {
      const level = parseInt(args[0]);
      if (isNaN(level) || level < 1 || level > 100) {
        console.error("Brightness must be 1-100");
        process.exit(1);
      }
      const targets = matchDevices(devices, args[1]);
      console.log(`Setting brightness to ${level}%:`);
      for (const d of targets) {
        await controlDevice(d, {
          type: "devices.capabilities.range",
          instance: "brightness",
          value: level,
        });
      }
      break;
    }

    case "temperature":
    case "temp": {
      const kelvin = parseInt(args[0]);
      if (isNaN(kelvin) || kelvin < 2000 || kelvin > 9000) {
        console.error("Color temperature must be 2000-9000K");
        process.exit(1);
      }
      const targets = matchDevices(devices, args[1]);
      console.log(`Setting color temperature to ${kelvin}K:`);
      for (const d of targets) {
        await controlDevice(d, {
          type: "devices.capabilities.color_setting",
          instance: "colorTemperatureK",
          value: kelvin,
        });
      }
      break;
    }

    case "scene": {
      if (!args[0]) {
        console.error("Usage: govee.ts scene <name> [device]");
        process.exit(1);
      }
      const targets = matchDevices(devices, args[1]);
      console.log(`Setting scene to "${args[0]}":`);
      for (const d of targets) {
        const sceneValue = getSceneValue(d, args[0]);
        if (sceneValue === null) {
          const available = listScenes(d);
          console.error(`  ✗ ${d.deviceName}: scene "${args[0]}" not found`);
          if (available.length > 0) {
            console.error(`    Available: ${available.join(", ")}`);
          }
          continue;
        }
        await controlDevice(d, {
          type: "devices.capabilities.dynamic_scene",
          instance: "lightScene",
          value: sceneValue,
        });
      }
      break;
    }

    case "scenes": {
      const targets = matchDevices(devices, args[0]);
      for (const d of targets) {
        const scenes = listScenes(d);
        console.log(`${d.deviceName} scenes:`);
        if (scenes.length === 0) {
          console.log("  (none)");
        } else {
          console.log(`  ${scenes.join(", ")}`);
        }
        console.log();
      }
      break;
    }

    case "diy-scenes": {
      const targets = matchDevices(devices, args[0]);
      for (const d of targets) {
        const result = (await apiPost("/device/diy-scenes", {
          requestId: `claudia-diy-${Date.now()}`,
          payload: { sku: d.sku, device: d.device },
        })) as {
          code: number;
          payload?: {
            capabilities?: Array<{
              instance: string;
              parameters: { options?: Array<{ name: string; value: number }> };
            }>;
          };
        };

        console.log(`${d.deviceName} DIY scenes:`);
        const caps = result.payload?.capabilities || [];
        const diyCap = caps.find((c) => c.instance === "diyScene");
        const options = diyCap?.parameters?.options || [];
        if (options.length === 0) {
          console.log("  (none)");
        } else {
          for (const o of options) {
            console.log(`  ${o.name.padEnd(30)} ${o.value}`);
          }
        }
        console.log();
      }
      break;
    }

    case "diy": {
      if (!args[0]) {
        console.error("Usage: govee.ts diy <name> [device]");
        process.exit(1);
      }
      const targets = matchDevices(devices, args[1]);
      const sceneName = args[0].toLowerCase();
      console.log(`Setting DIY scene to "${args[0]}":`);
      for (const d of targets) {
        const result = (await apiPost("/device/diy-scenes", {
          requestId: `claudia-diy-list-${Date.now()}`,
          payload: { sku: d.sku, device: d.device },
        })) as {
          payload?: {
            capabilities?: Array<{
              instance: string;
              parameters: { options?: Array<{ name: string; value: number }> };
            }>;
          };
        };

        const caps = result.payload?.capabilities || [];
        const diyCap = caps.find((c) => c.instance === "diyScene");
        const options = diyCap?.parameters?.options || [];
        const match =
          options.find((o) => o.name.toLowerCase() === sceneName) ||
          options.find((o) => o.name.toLowerCase().includes(sceneName));

        if (!match) {
          console.error(`  ✗ ${d.deviceName}: DIY scene "${args[0]}" not found`);
          if (options.length > 0) {
            console.error(`    Available: ${options.map((o) => o.name).join(", ")}`);
          }
          continue;
        }

        await controlDevice(d, {
          type: "devices.capabilities.dynamic_scene",
          instance: "diyScene",
          value: match.value,
        });
      }
      break;
    }

    case "state": {
      const targets = matchDevices(devices, args[0]);
      for (const d of targets) {
        const result = (await apiPost("/device/state", {
          requestId: `claudia-state-${Date.now()}`,
          payload: {
            sku: d.sku,
            device: d.device,
          },
        })) as {
          code: number;
          payload?: {
            capabilities?: Array<{
              type: string;
              instance: string;
              state: { value: unknown };
            }>;
          };
        };

        console.log(`${d.deviceName} (${d.sku}):`);
        if (result.code !== 200 || !result.payload?.capabilities) {
          console.log("  (state unavailable)");
          continue;
        }
        for (const cap of result.payload.capabilities) {
          const val = cap.state?.value;
          let display = String(val);
          if (cap.instance === "powerSwitch") display = val === 1 ? "ON" : "OFF";
          if (cap.instance === "brightness") display = `${val}%`;
          if (cap.instance === "colorTemperatureK") display = `${val}K`;
          if (cap.instance === "colorRgb" && typeof val === "number") {
            display = `#${val.toString(16).padStart(6, "0").toUpperCase()}`;
          }
          console.log(`  ${cap.instance}: ${display}`);
        }
        console.log();
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}. Run with --help for usage.`);
      process.exit(1);
  }
}

main();
