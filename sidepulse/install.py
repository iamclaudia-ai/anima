#!/usr/bin/env python3
"""Install Claudia's SidePulse animation profile.

Registers the .LED programs in ./animations as custom SidePulse animations,
maps every agent state to one, and saves two switchable profiles. Idempotent —
safe to re-run. Existing settings are backed up first.

Usage:  python3 sidepulse/install.py [--verify-only]
"""

from __future__ import annotations

import argparse
import datetime
import json
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "animations"
CFG = pathlib.Path.home() / ".config" / "sidepulse" / "agent-monitor"
SETT = CFG / "settings.json"
ANIM = CFG / "animations"

# Device firmware limits. Exceeding either makes the controller blink red.
MAX_BYTES, MAX_LINES = 512, 20

SERVICES = ("io.sidepulse.agentstatus", "io.sidepulse.service")

FILES = {
    "claudia-circuit": ("Claudia Circuit", "claudia-circuit.LED"),
    "claudia-kitt": ("Claudia KITT", "claudia-kitt.LED"),
    "claudia-kitt-slow": ("Claudia KITT Slow", "claudia-kitt-slow.LED"),
    "claudia-attention": ("Claudia Attention", "claudia-attention.LED"),
    "claudia-error": ("Claudia Error", "claudia-error.LED"),
    "claudia-complete": ("Claudia Complete", "claudia-complete.LED"),
    "claudia-idle": ("Claudia Idle", "claudia-idle.LED"),
    "claudia-greeting": ("Claudia Greeting", "claudia-greeting.LED"),
    "claudia-lid-closed": ("Claudia Lid Closed", "claudia-lid-closed.LED"),
}


def state_map(working: str) -> dict[str, str]:
    """SidePulse collapses working/tool_running/long_task_progress into one
    selection (see _agent_animation_settings), so all three get `working`."""
    return {
        "working": working,
        "tool_running": working,
        "long_task_progress": working,
        "waiting_for_input": "custom:claudia-attention",
        "blocked_error": "custom:claudia-error",
        "completed": "custom:claudia-complete",
        "idle_ready": "custom:claudia-idle",
        "unknown": "custom:claudia-idle",
        "lid_open": "custom:claudia-greeting",
        "lid_closed": "custom:claudia-lid-closed",
    }


def check_limits() -> None:
    for _, file_name in FILES.values():
        path = SRC / file_name
        if not path.exists():
            sys.exit(f"missing animation: {path}")
        body = path.read_text(encoding="utf-8")
        size, lines = len(body.encode()), len(body.splitlines())
        if size > MAX_BYTES or lines > MAX_LINES:
            sys.exit(f"{file_name}: {size}B/{lines} lines exceeds {MAX_BYTES}B/{MAX_LINES} lines")


def services(action: str) -> None:
    uid = f"gui/{__import__('os').getuid()}"
    for label in SERVICES:
        plist = pathlib.Path.home() / "Library" / "LaunchAgents" / f"{label}.plist"
        cmd = ["launchctl", "bootout", f"{uid}/{label}"] if action == "stop" else \
              ["launchctl", "bootstrap", uid, str(plist)]
        if action == "start" and not plist.exists():
            continue
        subprocess.run(cmd, capture_output=True, check=False)


def verify() -> bool:
    try:
        from sidepulse.settings import ANIMATION_STATES, load_settings
    except ImportError:
        print("! sidepulse package not importable — skipping deep verify")
        print("  retry with: ~/.local/share/sidepulse/venv/bin/python sidepulse/install.py --verify-only")
        return True

    settings = load_settings()
    programs = {p.read_text(encoding="utf-8").strip(): p.name for p in SRC.glob("*.LED")}
    ok = True
    for state in ANIMATION_STATES:
        animation = settings.agent_animation(state)
        name = programs.get((animation.custom_program or "").strip(), "-")
        good = animation.style == "custom" and name != "-"
        ok &= good
        print(f"  {'ok ' if good else 'FAIL'} {state:20} {name}")
    print(f"  profiles: {sorted(settings.agent_animation_profiles)}")
    return ok


def install() -> None:
    check_limits()
    if not SETT.exists():
        sys.exit(f"no SidePulse settings at {SETT} — install and run SidePulse first")

    ANIM.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = SETT.with_suffix(f".json.bak-{stamp}")
    shutil.copy2(SETT, backup)
    print(f"backup: {backup}")

    services("stop")
    try:
        for _, file_name in FILES.values():
            shutil.copy2(SRC / file_name, ANIM / file_name)

        data = json.loads(SETT.read_text(encoding="utf-8"))
        live = state_map("custom:claudia-circuit")
        data["custom_agent_animations"] = {
            f"custom:{slug}": {"name": name, "file": file_name}
            for slug, (name, file_name) in FILES.items()
        }
        data["agent_animations"] = {
            state: {"style": aid, "custom_program": ""} for state, aid in live.items()
        }
        data["agent_animation_profiles"] = {
            "profile:claudia": {
                "name": "Claudia",
                "animations": dict(sorted(state_map("custom:claudia-circuit").items())),
            },
            "profile:claudia-kitt": {
                "name": "Claudia KITT",
                "animations": dict(sorted(state_map("custom:claudia-kitt").items())),
            },
        }
        data["lid_open_animation"] = {
            "program": (SRC / "claudia-greeting.LED").read_text(encoding="utf-8"),
            "duration_seconds": 3.5,
        }
        data["lid_closed_animation"] = {
            "program": (SRC / "claudia-lid-closed.LED").read_text(encoding="utf-8"),
            "duration_seconds": 0.0,
        }

        tmp = SETT.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(SETT)
        print(f"installed {len(FILES)} animations + 2 profiles")
    finally:
        services("start")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true", help="check the installed profile, change nothing")
    args = parser.parse_args()

    if not args.verify_only:
        install()
    print("verifying:")
    sys.exit(0 if verify() else 1)


if __name__ == "__main__":
    main()
