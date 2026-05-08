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

The Govee app's auto-play feature isn't exposed via the API, so we built our own. Playlist files live in `playlists/` as JSON. Relative paths resolve under SKILL_DIR; absolute paths are used as-is.

```bash
# Advance to next scene in playlist
anima skill run controlling-lights auto-play playlists/st-patricks-day.json

# Check current state
anima skill run controlling-lights auto-play playlists/st-patricks-day.json --status

# Reset to beginning
anima skill run controlling-lights auto-play playlists/st-patricks-day.json --reset

# List all scenes in playlist
anima skill run controlling-lights auto-play playlists/st-patricks-day.json --list
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
Command: anima skill run controlling-lights auto-play playlists/st-patricks-day.json
```

### Available Playlists

Playlists and state are stored under SKILL_DIR (`~/.claude/skills/controlling-lights`). The `auto-play` script resolves relative paths automatically.

- `playlists/st-patricks-day.json` — 13 St. Patrick's Day DIY scenes

### Creating New Playlists

1. Run `anima skill run controlling-lights govee diy-scenes [device]` to list all DIY scenes with their values
2. Create a JSON file in `playlists/` with the scenes you want
3. Test with `anima skill run controlling-lights auto-play playlists/your-playlist.json`

## Notes

- The API has rate limits — avoid rapid successive calls
- Color values are integers: `(R << 16) | (G << 8) | B`
- Color temperature range: 2000K (warm candlelight) to 9000K (cool daylight)
- Scenes are device-specific — check with `scenes` command if one isn't found
- **DIY scenes** use a different API endpoint (`/device/diy-scenes`) than built-in scenes (`/device/scenes`)
- The basic device capabilities list returns empty scene options — always use the dedicated endpoints
