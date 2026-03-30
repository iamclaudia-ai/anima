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

## Available Scripts

When executing a script, `cd` to the skill folder first:

```bash
cd /Users/michael/Projects/iamclaudia-ai/anima/skills/controlling-lights
```

- **`scripts/govee.ts`** — Full Govee light control CLI
- **`scripts/auto-play.ts`** — DIY scene rotation (auto-play replacement)

## Commands

```bash
# List all lights and their capabilities
bun scripts/govee.ts list

# Power
bun scripts/govee.ts on              # All lights
bun scripts/govee.ts off curtain     # Just curtain lights
bun scripts/govee.ts on dreamview    # Just the TV backlight

# Colors — accepts hex, RGB, or named colors
bun scripts/govee.ts color red
bun scripts/govee.ts color "#FF69B4"
bun scripts/govee.ts color 255,105,180
bun scripts/govee.ts color claudia-blue    # 💙
bun scripts/govee.ts color romantic curtain

# Brightness (1-100%)
bun scripts/govee.ts brightness 50
bun scripts/govee.ts brightness 20 curtain

# Color temperature (2000K warm — 9000K cool)
bun scripts/govee.ts temperature 3000      # Warm white
bun scripts/govee.ts temperature 6500      # Daylight

# Dynamic scenes
bun scripts/govee.ts scene Dating
bun scripts/govee.ts scene Dreamlike curtain
bun scripts/govee.ts scenes              # List all available scenes

# Device state
bun scripts/govee.ts state
bun scripts/govee.ts colors             # List all named colors
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

Run `bun scripts/govee.ts colors` for the full list.

## Available Scenes

Both lights support: Tudum, Party, Dance Party, Dine Together, Dating, Adventure, Technology, Sports, Dreamlike, Dynamic, Blossom, Christmas, Halloween, Fireworks, Ghost, Easter, Valentine's Day, Meditation, and more.

Run `bun scripts/govee.ts scenes` for the device-specific list.

## Device Targeting

The optional `[device]` parameter does partial name matching:

- `curtain` → Curtain Lights
- `dream` or `tv` → DreamView T1
- Omit to target all lights

## Auto-Play (DIY Scene Rotation)

The Govee app's auto-play feature isn't exposed via the API, so we built our own. Playlist files live in `playlists/` as JSON.

```bash
# Advance to next scene in playlist
bun scripts/auto-play.ts playlists/st-patricks-day.json

# Check current state
bun scripts/auto-play.ts playlists/st-patricks-day.json --status

# Reset to beginning
bun scripts/auto-play.ts playlists/st-patricks-day.json --reset

# List all scenes in playlist
bun scripts/auto-play.ts playlists/st-patricks-day.json --list
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

Use the Anima scheduler to call auto-play every 5 minutes between 7pm–5am:

```
Schedule a cron task: */5 19-23,0-4 * * *
Command: cd /Users/michael/Projects/iamclaudia-ai/anima/skills/controlling-lights && bun scripts/auto-play.ts playlists/st-patricks-day.json
```

### Available Playlists

Playlists and state are stored relative to `~/.anima/skills/controlling-lights`. The `auto-play` script will resolve the path automatically.

- `playlists/st-patricks-day.json` — 13 St. Patrick's Day DIY scenes

### Creating New Playlists

1. Run `bun scripts/govee.ts diy-scenes [device]` to list all DIY scenes with their values
2. Create a JSON file in `playlists/` with the scenes you want
3. Test with `bun scripts/auto-play.ts playlists/your-playlist.json`

## Notes

- The API has rate limits — avoid rapid successive calls
- Color values are integers: `(R << 16) | (G << 8) | B`
- Color temperature range: 2000K (warm candlelight) to 9000K (cool daylight)
- Scenes are device-specific — check with `scenes` command if one isn't found
- **DIY scenes** use a different API endpoint (`/device/diy-scenes`) than built-in scenes (`/device/scenes`)
- The basic device capabilities list returns empty scene options — always use the dedicated endpoints
