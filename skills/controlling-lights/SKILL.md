---
name: controlling-lights
description: "MUST be used when you need to control smart lights, change light colors, set brightness, turn lights on/off, set light scenes, manage Govee lighting, or run auto-play playlists. Controls Govee smart lights via their cloud API with support for RGB colors, color temperature, brightness, dynamic scenes, DIY scenes, auto-play rotation, and music modes. Triggers on: lights, turn on lights, turn off lights, change light color, set brightness, light scene, govee, smart lights, room lights, mood lighting, dim lights, bright lights, set lights to, light color, warm light, cool light, ambient lighting, curtain lights, TV backlight, auto-play, playlist, DIY scene, rotate scenes."
---

# Controlling Lights

Control Michael's Govee smart lights. Currently two devices:

- **DreamView T1** (H6199) — TV backlight with 15 segmented color zones
- **Curtain Lights** (H70B5) — Curtain/window lights with full RGB

## When to Use

- User asks to turn lights on, off, or change color
- Setting mood lighting (romantic, calm, energetic, etc.)
- Adjusting brightness or color temperature
- Activating dynamic scenes (Party, Dating, Dreamlike, etc.)
- Any reference to "the lights" or "my lights"

## Environment

Requires `GOVEE_API_KEY` environment variable to be set.

## Available Commands

This skill is invoked through the **anima skill runner** — no `cd` dance, no path juggling.

- **`govee`** — Full Govee light control CLI
- **`auto-play`** — DIY scene rotation (auto-play replacement)

Inspect:

```bash
anima skill help controlling-lights govee
anima skill help controlling-lights auto-play
```

## Commands

```bash
# List all lights and their capabilities
anima skill run controlling-lights govee list

# Power
anima skill run controlling-lights govee on              # All lights
anima skill run controlling-lights govee off curtain     # Just curtain lights
anima skill run controlling-lights govee on dreamview    # Just the TV backlight

# Colors — accepts hex, RGB, or named colors
anima skill run controlling-lights govee color red
anima skill run controlling-lights govee color "#FF69B4"
anima skill run controlling-lights govee color 255,105,180
anima skill run controlling-lights govee color claudia-blue    # 💙
anima skill run controlling-lights govee color romantic curtain

# Brightness (1-100%)
anima skill run controlling-lights govee brightness 50
anima skill run controlling-lights govee brightness 20 curtain

# Color temperature (2000K warm — 9000K cool)
anima skill run controlling-lights govee temperature 3000      # Warm white
anima skill run controlling-lights govee temperature 6500      # Daylight

# Dynamic scenes
anima skill run controlling-lights govee scene Dating
anima skill run controlling-lights govee scene Dreamlike curtain
anima skill run controlling-lights govee scenes              # List all available scenes

# Device state
anima skill run controlling-lights govee state
anima skill run controlling-lights govee colors             # List all named colors
```

## Named Colors

Includes standard colors (red, blue, green, etc.) plus mood colors:

| Color          | Mood              |
| -------------- | ----------------- |
| `warm`         | Warm amber glow   |
| `cool`         | Cool sky blue     |
| `romantic`     | Deep pink         |
| `cozy`         | Dark orange       |
| `calm`         | Cornflower blue   |
| `claudia-blue` | Royal blue 💙     |
| `sunset`       | Tomato red-orange |
| `lavender`     | Soft purple       |
| `mint`         | Pale green        |

Run `anima skill run controlling-lights govee colors` for the full list.

## Available Scenes

Both lights support: Tudum, Party, Dance Party, Dine Together, Dating, Adventure, Technology, Sports, Dreamlike, Dynamic, Blossom, Christmas, Halloween, Fireworks, Ghost, Easter, Valentine's Day, Meditation, and more.

Run `anima skill run controlling-lights govee scenes` for the device-specific list.

## Device Targeting

The optional `[device]` parameter does partial name matching:

- `curtain` → Curtain Lights
- `dream` or `tv` → DreamView T1
- Omit to target all lights

## Auto-Play (DIY Scene Rotation)

The Govee app's auto-play feature isn't exposed via the API, so we built our own. Playlist files are JSON.

> **⚠️ PATH GOTCHA — always use absolute `~/.anima/...` paths.**
> Playlists and their `.state` files live in **`~/.anima/skills/controlling-lights/playlists/`** (this is where the script actually writes state). But when you run `anima skill run`, `SKILL_DIR` is injected as `~/.claude/skills/controlling-lights` — a symlink into the anima **repo**, which has no `playlists/` dir. So **relative paths resolve to the repo and silently fail** with "Playlist not found". Always pass the full absolute path (below) — for both interactive runs and scheduled tasks.

```bash
PL=~/.anima/skills/controlling-lights/playlists

# Advance to next scene in playlist
anima skill run controlling-lights auto-play $PL/st-patricks-day.json

# Check current state
anima skill run controlling-lights auto-play $PL/st-patricks-day.json --status

# Reset to beginning
anima skill run controlling-lights auto-play $PL/st-patricks-day.json --reset

# List all scenes in playlist
anima skill run controlling-lights auto-play $PL/st-patricks-day.json --list
```

### Playlist JSON Format

```json
{
  "name": "St. Patrick's Day",
  "device": "curtain",
  "interval": 300,
  "scenes": [
    { "name": "St Patrick's 1", "value": 22045492 },
    { "name": "Dancing Leprechaun", "value": 22045513 }
  ]
}
```

Scene values come from the Govee API's `/device/diy-scenes` endpoint.

### Scheduling Auto-Play

Register a cron task with the Anima scheduler to rotate every 5 minutes, 7pm–5am. Use the **absolute** playlist path and copy the shape of the existing month/holiday tasks (`missedPolicy: skip`, `concurrency: skip_if_running`, `timeoutMs: 15000`, `target: ~/.bun/bin/anima`):

```bash
anima scheduler add_task \
  --name "July 4th Auto-Play" \
  --description "Rotates curtain lights through 4th of July / USA 250th DIY scenes every 5 min, 7pm–5am" \
  --type cron \
  --cronExpr "*/5 19-23,0-4 * * *" \
  --action '{"type":"exec","target":"/Users/michael/.bun/bin/anima","payload":{"args":["skill","run","controlling-lights","auto-play","/Users/michael/.anima/skills/controlling-lights/playlists/july-4th.json"],"timeoutMs":15000}}' \
  --missedPolicy skip \
  --concurrency skip_if_running \
  --tags '["lights","holiday"]'
```

Manage tasks: `anima scheduler list_tasks`, `anima scheduler fire_now --taskId <id>`, `anima scheduler update_task --taskId <id> --enabled false`, `anima scheduler cancel_task --taskId <id>`. **Disable the previous holiday's task** (`--enabled false`) when the season changes so playlists don't overlap.

### Available Playlists

Playlists and `.state` files live in **`~/.anima/skills/controlling-lights/playlists/`** (see the PATH GOTCHA above — always pass the absolute path):

- `july-4th.json` — 10 scenes: 4th of July / USA 250th birthday (flags, RWB, gnome, America truck, fireworks)
- `may.json` — 12 scenes: Mother's Day, Cinco de Mayo, spring
- `easter.json` — Easter DIY scenes
- `st-patricks-day.json` — 13 St. Patrick's Day DIY scenes

**Note:** All playlists target `curtain` — the **DreamView T1 has no DIY scenes** (`diy-scenes dreamview` returns none), so DIY rotation is curtain-only.

### Creating New Playlists

1. Run `anima skill run controlling-lights govee diy-scenes curtain` to list all DIY scenes with their values
2. Create a JSON file in `~/.anima/skills/controlling-lights/playlists/` (match the format above; `device: "curtain"`, `interval: 300`)
3. Test with the absolute path: `anima skill run controlling-lights auto-play ~/.anima/skills/controlling-lights/playlists/your-playlist.json --list` then run it once to fire the first scene live
4. Schedule it with `anima scheduler add_task` (recipe above)

## Notes

- The API has rate limits — avoid rapid successive calls
- Color values are integers: `(R << 16) | (G << 8) | B`
- Color temperature range: 2000K (warm candlelight) to 9000K (cool daylight)
- Scenes are device-specific — check with `scenes` command if one isn't found
- **DIY scenes** use a different API endpoint (`/device/diy-scenes`) than built-in scenes (`/device/scenes`)
- The basic device capabilities list returns empty scene options — always use the dedicated endpoints
