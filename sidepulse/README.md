# SidePulse — Claudia's animation profile

Custom LED animations for [SidePulse Pro / Dot](https://sidepulse.io), in
Claudia's colors: purple `#6e1fff` and blue `#1f41ea` — the same two values
`ThinkingFrame` uses to animate the logo on screen.

SidePulse's own agent monitor keeps ownership of the device. It already hooks
every Claude Code lifecycle event, aggregates across agents, and handles
battery, lid state, and the SD-slot keepalive. This just replaces the colors it
paints with, so there is no second writer fighting for `LEDS.LED`.

## Install

```sh
python3 sidepulse/install.py                 # install, then verify
python3 sidepulse/install.py --verify-only   # check only, change nothing
```

Backs up `settings.json` first, stops the SidePulse services while writing, and
restarts them after. Idempotent.

For the deep verification pass (reads the result back through SidePulse's own
parser rather than trusting our JSON), run it with their interpreter:

```sh
~/.local/share/sidepulse/venv/bin/python sidepulse/install.py --verify-only
```

## States

| State                                             | Animation            | Looks like                                                                                         |
| ------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| `working` · `tool_running` · `long_task_progress` | `claudia-circuit`    | Random LEDs snapping purple/blue/dark every 90ms — the logo's circuit flicker                      |
| `waiting_for_input`                               | `claudia-attention`  | Purple double-blink, pause, blue double-blink, pause                                               |
| `blocked_error`                                   | `claudia-error`      | Red double-blink. The one deliberate break from the palette — being unmistakable matters more here |
| `completed`                                       | `claudia-complete`   | Diamond Heart bloom: gold core radiating out through pink and violet to blue, twice, then dark     |
| `idle_ready` · `unknown`                          | `claudia-idle`       | Dim slow breathe between blue and purple                                                           |
| `lid_open`                                        | `claudia-greeting`   | The heart bloom, three times — hello again                                                         |
| `lid_closed`                                      | `claudia-lid-closed` | Very dim breathe at brightness 40                                                                  |

`claudia-kitt` and `claudia-kitt-slow` are registered as choices but unmapped
by default — see profiles below.

## Profiles

Two are saved, switchable from the SidePulse menubar:

- **Claudia** — `claudia-circuit` while working (default)
- **Claudia KITT** — `claudia-kitt` instead: a purple sweep out, a blue sweep
  back, 300ms pulse on a 77ms stagger

Why a profile switch rather than both at once: SidePulse deliberately collapses
`working`, `tool_running`, and `long_task_progress` into a single selection
(`_agent_animation_settings` copies whichever is set across all three), so only
one working animation can be live.

## Editing the animations

Programs are plain text in `animations/`, in SidePulse's `LEDS.LED` DSL. Two
hard firmware limits, both enforced by `install.py` before it writes anything:

- **512 bytes**
- **20 lines**

Exceed either and the controller blinks red six times instead of playing. Each
per-LED state change costs 15-20 bytes, which caps a program at roughly 25
changes — about a 2 second loop before it repeats.

Useful DSL notes:

- `<i>:#rrggbb <duration> <easing> <delay>` addresses one LED; several
  segments separated by `;` share a line but keep independent clocks
- `pulse` is a full cycle — up to the target color and back — so a staggered
  row of `pulse` steps reads as a travelling comet. Tail length is
  `duration ÷ stagger`; scale both together to change speed without changing
  the tail
- `brightness N` at the top scales the whole program
- `repeat` loops forever from line 1; `repeat N` runs N times and can be
  followed by more lines

Preview a program before installing by writing it straight to the device, with
the agent monitor stopped so it doesn't immediately reclaim the file:

```sh
launchctl bootout gui/$UID/io.sidepulse.agentstatus
launchctl bootout gui/$UID/io.sidepulse.service
cat sidepulse/animations/claudia-circuit.LED > /Volumes/SidePulse/LEDS.LED
# ... look at it ...
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/io.sidepulse.service.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/io.sidepulse.agentstatus.plist
```

The mount point is `/Volumes/SidePulse` on this machine — SidePulse's own docs
say `/Volumes/SidePulsePro`, so discover it rather than hardcoding.

## Known tradeoff

Profile animations are static files, so `claudia-circuit` plays one fixed
1.26s flicker rather than re-rolling per turn. Identical in motion, but it does
repeat. Per-turn randomization would need an Anima extension writing
`LEDS.LED` directly, which means taking ownership of the device away from
SidePulse's service — deliberately not done.
