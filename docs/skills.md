# Skills

Skills are self-contained capability packages that the agent loads on-demand. A skill provides specialized workflows, setup instructions, helper scripts, and reference documentation for specific tasks.

Claudia follows the [Agent Skills standard](https://agentskills.io/specification), with lenient loading behavior to keep valid skills usable even when some metadata is imperfect.

## Locations

> Security: Skills can instruct the model to perform actions and may include executable code the model invokes. Review skill content before use.

Claudia loads skills from:

- Global:
  - `~/.claudia/skills/`
  - `~/.claude/skills/`
  - `~/.agents/skills/`
- Project:
  - `.claudia/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)

Discovery rules:

- Direct `.md` files in the skills directory root
- Recursive `SKILL.md` files under subdirectories

### Configured Paths

You can add extra probe paths in `~/.claudia/claudia.json`:

```json
{
  "session": {
    "skills": {
      "paths": ["~/.claudia/skills", "~/.claude/skills", ".claudia/skills", "../shared-skills"]
    }
  }
}
```

These paths are additive to defaults. Path resolution:

- Starts with `~` or `/`: treated as absolute (`~` expands to home)
- Otherwise: resolved relative to the session `cwd`

## How Skills Work

1. At session startup, Claudia scans skill locations and extracts names and descriptions.
1. The system prompt includes available skills in XML format per the [specification](https://agentskills.io/integrate-skills).
1. When a task matches, the agent uses `read` to load the full `SKILL.md`.
1. The agent follows the instructions, resolving relative paths from the skill directory.

This is progressive disclosure: descriptions are always in context; full instructions load on demand.

## Skill Structure

A skill is a directory with a `SKILL.md` file. Everything else is freeform.

```text
my-skill/
├── SKILL.md
├── scripts/
│   └── process.sh
├── references/
│   └── api-reference.md
└── assets/
    └── template.json
```

### `SKILL.md` Format

````markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:

```bash
cd /path/to/skill && npm install
```
````

## Usage

```bash
./scripts/process.sh <input>
```

````

Use relative paths from the skill directory:

```markdown
See [the reference guide](references/REFERENCE.md) for details.
````

## Script Execution Best Practice

When a skill includes helper scripts, prefer a `scripts/` folder and explicitly run from the skill directory. This avoids failures when session `cwd` is different from where the skill is installed.

Recommended pattern in `SKILL.md` instructions:

```bash
cd <skill_dir> && node scripts/generate-audio.js <markdown-path>
```

Avoid ambiguous commands like:

```bash
node generate-audio.js <markdown-path>
```

That often runs from the session `cwd` (or output directory) and fails to find the script.

### Real Example (Guiding Meditation)

`guiding-meditation` uses this command shape:

```bash
cd /Users/michael/.claude/skills/guiding-meditation && node scripts/generate-audio.js /Users/michael/meditations/2026-03-03-morning-awakening.md
```

This works regardless of the current session directory.

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field                      | Required | Description                                                                       |
| -------------------------- | -------- | --------------------------------------------------------------------------------- |
| `name`                     | Yes      | Max 64 chars. Lowercase a-z, 0-9, hyphens. Must match parent directory.           |
| `description`              | Yes      | Max 1024 chars. What the skill does and when to use it.                           |
| `license`                  | No       | License name or reference to bundled file.                                        |
| `compatibility`            | No       | Max 500 chars. Environment requirements.                                          |
| `metadata`                 | No       | Arbitrary key-value mapping.                                                      |
| `allowed-tools`            | No       | Space-delimited list of pre-approved tools (experimental).                        |
| `disable-model-invocation` | No       | When `true`, skill is hidden from system prompt and requires explicit invocation. |

## Validation

Typical validation issues are warnings and do not necessarily prevent loading:

- Name does not match parent directory
- Name exceeds 64 characters or contains invalid characters
- Name starts/ends with hyphen or has consecutive hyphens
- Description exceeds 1024 characters

Skills missing description are skipped.

When two skills share the same `name`, the first discovered skill is kept.

## Example

```text
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

````markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && npm install
```
````

## Search

```bash
./search.js "query"
./search.js "query" --content
```

## Extract Page Content

```bash
./content.js https://example.com
```

```

```
