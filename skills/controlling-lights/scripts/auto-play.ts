#!/usr/bin/env bun
/**
 * Auto-Play DIY Scene Rotation
 *
 * Advances to the next scene in a playlist JSON file each time it's called.
 * Tracks state in a .state file next to the playlist JSON.
 *
 * Usage:
 *   bun scripts/auto-play.ts <playlist.json>           # Advance to next scene
 *   bun scripts/auto-play.ts <playlist.json> --status   # Show current state
 *   bun scripts/auto-play.ts <playlist.json> --reset    # Reset to first scene
 *   bun scripts/auto-play.ts <playlist.json> --list     # List all scenes
 */

import "./env";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";

const API_BASE = "https://openapi.api.govee.com/router/api/v1";
const API_KEY = process.env.GOVEE_API_KEY;

if (!API_KEY) {
  console.error("Error: GOVEE_API_KEY environment variable is required");
  process.exit(1);
}

// ── Types ────────────────────────────────────────────

interface PlaylistScene {
  name: string;
  value: number;
}

interface Playlist {
  name: string;
  device: string;
  interval: number;
  scenes: PlaylistScene[];
}

interface PlaylistState {
  lastIndex: number;
  lastScene: string;
  lastPlayed: string;
  playCount: number;
}

interface GoveeDevice {
  sku: string;
  device: string;
  deviceName: string;
  type: string;
}

// ── Load playlist ────────────────────────────────────

const [playlistPath, ...flags] = process.argv.slice(2);

if (!playlistPath || playlistPath === "--help") {
  console.log(`Auto-Play DIY Scene Rotation

Usage:
  bun scripts/auto-play.ts <playlist.json>           Advance to next scene
  bun scripts/auto-play.ts <playlist.json> --status   Show current state
  bun scripts/auto-play.ts <playlist.json> --reset    Reset to first scene
  bun scripts/auto-play.ts <playlist.json> --list     List all scenes`);
  process.exit(0);
}
const skillsPath = "/Users/michael/.anima/skills/controlling-lights";
const resolvedPath = resolve(skillsPath, playlistPath);
if (!existsSync(resolvedPath)) {
  console.error(`Playlist not found: ${resolvedPath}`);
  process.exit(1);
}

const playlist: Playlist = JSON.parse(readFileSync(resolvedPath, "utf-8"));
const statePath = resolve(dirname(resolvedPath), `.${basename(resolvedPath, ".json")}.state`);

if (playlist.scenes.length === 0) {
  console.error("Playlist has no scenes");
  process.exit(1);
}

// ── State management ─────────────────────────────────

function loadState(): PlaylistState {
  if (existsSync(statePath)) {
    try {
      return JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {
      // Corrupted state, start fresh
    }
  }
  return { lastIndex: -1, lastScene: "", lastPlayed: "", playCount: 0 };
}

function saveState(state: PlaylistState): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// ── Device resolution ────────────────────────────────

async function getDevices(): Promise<GoveeDevice[]> {
  const res = await fetch(`${API_BASE}/user/devices`, {
    headers: { "Govee-API-Key": API_KEY!, "Content-Type": "application/json" },
  });
  const result = (await res.json()) as { data: GoveeDevice[] };
  return result.data.filter((d) => d.type === "devices.types.light");
}

function matchDevice(devices: GoveeDevice[], filter: string): GoveeDevice {
  const lower = filter.toLowerCase();
  const match = devices.find(
    (d) => d.deviceName.toLowerCase().includes(lower) || d.sku.toLowerCase().includes(lower),
  );
  if (!match) {
    console.error(`No device matching "${filter}". Available:`);
    for (const d of devices) {
      console.error(`  - ${d.deviceName} (${d.sku})`);
    }
    process.exit(1);
  }
  return match;
}

// ── Commands ─────────────────────────────────────────

const flag = flags[0];

if (flag === "--status") {
  const state = loadState();
  console.log(`Playlist: ${playlist.name}`);
  console.log(`Scenes:   ${playlist.scenes.length}`);
  console.log(`Device:   ${playlist.device}`);
  if (state.lastIndex === -1) {
    console.log(`Status:   Not started`);
  } else {
    console.log(`Current:  [${state.lastIndex + 1}/${playlist.scenes.length}] ${state.lastScene}`);
    console.log(`Played:   ${state.lastPlayed}`);
    console.log(`Total:    ${state.playCount} plays`);
  }
  process.exit(0);
}

if (flag === "--reset") {
  saveState({ lastIndex: -1, lastScene: "", lastPlayed: "", playCount: 0 });
  console.log(`Reset "${playlist.name}" to beginning`);
  process.exit(0);
}

if (flag === "--list") {
  const state = loadState();
  console.log(`${playlist.name} — ${playlist.scenes.length} scenes:\n`);
  for (let i = 0; i < playlist.scenes.length; i++) {
    const marker = i === state.lastIndex ? " ◀ current" : "";
    console.log(`  ${String(i + 1).padStart(2)}. ${playlist.scenes[i].name}${marker}`);
  }
  process.exit(0);
}

// ── Advance to next scene ────────────────────────────

const state = loadState();
const nextIndex = (state.lastIndex + 1) % playlist.scenes.length;
const scene = playlist.scenes[nextIndex];

const devices = await getDevices();
const device = matchDevice(devices, playlist.device);

const res = await fetch(`${API_BASE}/device/control`, {
  method: "POST",
  headers: { "Govee-API-Key": API_KEY!, "Content-Type": "application/json" },
  body: JSON.stringify({
    requestId: `autoplay-${Date.now()}`,
    payload: {
      sku: device.sku,
      device: device.device,
      capability: {
        type: "devices.capabilities.dynamic_scene",
        instance: "diyScene",
        value: scene.value,
      },
    },
  }),
});

const result = (await res.json()) as { code: number; msg: string };

if (result.code !== 200) {
  console.error(`✗ Failed to set scene: ${result.msg}`);
  process.exit(1);
}

const newState: PlaylistState = {
  lastIndex: nextIndex,
  lastScene: scene.name,
  lastPlayed: new Date().toISOString(),
  playCount: state.playCount + 1,
};
saveState(newState);

console.log(`✓ [${nextIndex + 1}/${playlist.scenes.length}] ${scene.name} → ${device.deviceName}`);
