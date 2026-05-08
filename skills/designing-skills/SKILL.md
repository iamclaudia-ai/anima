---
name: designing-skills
description: "MUST be used when creating, writing, or designing new skills for Claude Code. Covers skill structure, naming conventions, description writing, and trigger optimization. Triggers on: create skill, write skill, new skill, design skill, add skill, skill template, skill structure, skill description, make a skill."
---

# Designing Skills for Claude Code

Use this skill when creating new skills to ensure they are discoverable and useful.

## Critical Insight

**The name and description determine whether an agent will EVER use your skill.** Get these wrong and the skill will sit unused while the agent struggles without it.

## Skill Structure

```
skills/
└── skill-name/             # lowercase-with-hyphens, matches name in frontmatter
    ├── SKILL.md            # The skill definition (mandatory)
    ├── skill.json          # Optional: declares commands for the runner (see below)
    └── scripts/            # Executable scripts (one per skill command)
        └── my-script.ts    # Convention: scripts/<command-name>.{js,ts,py,sh}
```

## Running Skills via the Anima Skill Runner

**All skill scripts are invoked through the Anima runner**, which resolves the
script, sets cwd, and injects env vars. Scripts no longer need a `cd` dance:

```bash
anima skill run <skill-id> <command> [args...]      # synchronous
anima skill run <skill-id> <command> [...] --task   # queue via scheduler
anima skill task <task-id> --watch                  # poll a queued task
anima skill list                                    # discovery
anima skill help <skill-id> <command>               # per-command help
```

The runner injects these env vars before exec:

- **`SKILL_DIR`** — Absolute path to the skill directory. Use this for any
  skill-internal resource. Never use `process.cwd()`.
- **`SKILL_ID`** — Skill identifier
- **`SKILL_COMMAND`** — Command name
- **`ANIMA_TASK_ID`** — Only set in `--task` mode. Pass to
  `anima scheduler update_progress --taskId "$ANIMA_TASK_ID" --message "..."`
  for live progress reporting.
- **`ANIMA_EXECUTION_ID`** — Only set in `--task` mode

## skill.json — Optional Metadata

When absent, any executable file under `scripts/` is callable by basename
(e.g., `scripts/foo.js` → `anima skill run myskill foo`). Runtime is
auto-detected by extension or shebang.

For richer behavior — argv help, longRunning auto-queue, required env
checks — add a `skill.json`:

```json
{
  "id": "writing-romance-novels",
  "description": "Generate full-length romance novels — chapter MP3s and AI cover art.",
  "commands": {
    "generate-audio": {
      "script": "scripts/generate-audio.js",
      "runtime": "node",
      "longRunning": true,
      "description": "Generate MP3 audio from chapter markdown using ElevenLabs v3.",
      "args": [
        {
          "name": "chapter-path",
          "type": "absolute-file",
          "required": true,
          "description": "Absolute path to the chapter .md file"
        }
      ],
      "env": ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"],
      "timeoutMs": 1800000
    }
  }
}
```

**Effects of `longRunning: true`**: The runner auto-enables `--task` mode
(returns task ID immediately, executes via the scheduler). Pass `--sync` to
override and run inline.

## Frontmatter Format

```yaml
---
name: skill-name # lowercase-with-hyphens
description: "..." # What it does AND when to use it - MUST be quoted
---
```

## Description Requirements

The description MUST include:

1. **What the skill does** (capabilities)
2. **ALL activities covered** — If the skill handles creating, reviewing, updating, and auditing, say so explicitly. Users phrase requests differently ("assess", "check", "audit", "review", "modify", "update", "create", "build"). Include all that should trigger your skill.
3. **When to use it** (trigger conditions)
4. **Action words** like "MUST be loaded before..." or "Use PROACTIVELY when..." for skills that should auto-invoke

## Naming Conventions

- **Use gerund form** (verb ending in -ing): `developing-*`, `processing-*`, `managing-*`, `setting-up-*`
- **Use plural nouns**: `developing-skills`, `processing-images`, `managing-ads`

## Example: Good Description

```yaml
name: browsing-the-web
description: "MUST be used when you need to browse the web. Efficient browser automation designed for agents - enables intuitive web navigation, form filling, screenshots, and data scraping through accessibility-based workflows. Triggers on: browse website, visit URL, open webpage, fill form, click button, take screenshot, scrape data, web automation, interact with website."
```

**Why it works:**

- Starts with "MUST be used when..." (strong trigger)
- Lists capabilities (navigation, forms, screenshots, scraping)
- Includes many trigger phrases users might say

## Example: Transcription Skill

```yaml
name: transcribing-audio
description: "MUST be used when you need to transcribe audio files to text. Local speech-to-text (STT) transcription using Parakeet MLX on Apple Silicon - fast, private, offline. Triggers on: transcribe audio, convert audio to text, speech to text, STT, transcription, get text from audio, audio file transcription, voice to text, extract text from recording, transcribe podcast, transcribe meeting, transcribe voice memo."
```

## Testing Your Skill

If an agent doesn't invoke your skill, it's almost always because **the description didn't match how the user phrased their request**.

Test against multiple phrasings:

- "transcribe this audio" ✓
- "convert this to text" ✓
- "what does this recording say" ✓
- "STT on this file" ✓

## Skill Body

After the frontmatter, include:

- **When to Use** section with bullet points
- **Available Commands** — list the commands the skill exposes through the runner
- **Instructions** for how to accomplish the task
- **Examples** showing `anima skill run …` invocations
- **Notes** for edge cases or important details

## Writing Scripts that Work with the Runner

1. **Take absolute paths in argv.** Don't infer paths from CWD. The runner sets
   cwd to `SKILL_DIR` for safety, but explicit absolute paths are clearer.
2. **Use `process.env.SKILL_DIR`** for any skill-internal resource (data files,
   playlists, prompt templates) instead of relative paths or `process.cwd()`.
3. **Report progress for long tasks** via `anima scheduler update_progress`
   when `ANIMA_TASK_ID` is set (no-op when not):

   ```js
   const { spawnSync } = require("child_process");
   function progress(message) {
     if (!process.env.ANIMA_TASK_ID) return;
     spawnSync(
       "anima",
       [
         "scheduler",
         "update_progress",
         "--taskId",
         process.env.ANIMA_TASK_ID,
         "--message",
         message,
       ],
       { stdio: "ignore", timeout: 5000 },
     );
   }
   ```

4. **Validate required env vars early** and exit with a clear error. The runner
   also checks `commands.*.env` from `skill.json` before exec.

## Template

```markdown
---
name: doing-something
description: "MUST be used when [trigger condition]. [What it does]. Triggers on: [phrase1], [phrase2], [phrase3], [phrase4], [phrase5]."
---

# Doing Something

Use this skill when the user wants to [goal].

## When to Use

- [Scenario 1]
- [Scenario 2]
- [Scenario 3]

## Available Commands

This skill is invoked through the **anima skill runner**.

- **`<command-name>`** — description of what the command does

Inspect:

\`\`\`bash
anima skill help doing-something <command-name>
\`\`\`

## Instructions

1. [Step 1]
2. [Step 2]
3. [Step 3] — `anima skill run doing-something <command> <absolute-path-arg>`

## Examples

\`\`\`bash
anima skill run doing-something <command> /absolute/path/to/input
\`\`\`

## Notes

- [Important note 1]
- [Important note 2]
```

### skill.json template

```json
{
  "id": "doing-something",
  "description": "Short description shown in `anima skill list`.",
  "commands": {
    "<command-name>": {
      "script": "scripts/<command-name>.<ext>",
      "runtime": "node | bun | python3 | bash",
      "longRunning": false,
      "description": "What the command does.",
      "args": [
        {
          "name": "arg-name",
          "type": "absolute-file | absolute-folder | string | number | boolean",
          "required": true,
          "description": "What this argument is for"
        }
      ],
      "env": ["REQUIRED_ENV_VAR_1", "REQUIRED_ENV_VAR_2"],
      "timeoutMs": 600000
    }
  }
}
```
