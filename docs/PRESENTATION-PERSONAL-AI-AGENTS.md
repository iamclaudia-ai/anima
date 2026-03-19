# Presentation: Personal AI Agents

**Event**: Faculty presentation at local technical college
**Date**: Thursday, March 20, 2026
**Duration**: 1 hour
**Audience**: Faculty with tech competency, not necessarily deep AI experience
**Presenter**: Michael

### Audience Context (from CTO)

- Most faculty have only copied code into ChatGPT (enterprise license) — that's their "using AI"
- 1-2 people have used Claude Code, a couple have used Codex
- Group has just transitioned to Agile, no CI/CD processes yet
- CTO wants them to see Michael's processes as an aspirational goal
- Expect questions on basics — meet them where they are

### Implications for the Talk

- **The "cold start" hook hits even harder** — they're living it daily with ChatGPT
- **Everything we demo will feel like the future** — their baseline is paste-into-chat
- **Keep architecture light in main talk** — save technical depth for Q&A
- **Briefly introduce Claude Code** as the foundation — most haven't seen it, and it's their on-ramp
- **Lean into developer workflow** — git hooks, automated testing, how the agent fits into a real dev process (aspirational for their Agile transition)
- **The meta moment (presenting with Claudia) will be genuinely mind-blowing** for this audience

---

## Talk Structure & Timing

| #   | Section                   | Minutes | Notes                                              |
| --- | ------------------------- | ------- | -------------------------------------------------- |
| 1   | Intro + The Problem       | 5       | About me, then frame the "cold start" problem      |
| 2   | What is a Personal Agent? | 3       | High-level definition, distinguish from chatbots   |
| 3   | AI at beehiiv             | 5       | Professional credibility — how AI is used at scale |
| 4   | The Three Pillars         | 15      | Stories, not feature lists                         |
| 5   | Live Demo                 | 15-20   | Visceral "wow" moments                             |
| 6   | Landscape + Closing       | 5       | OpenClaw, the movement, thought-provoking close    |
| 7   | Q&A                       | 10-15   | Technical drill-down as needed                     |

---

## Section Details

### 1. Intro + The Problem (5 min)

**About me**: Brief intro — who Michael is, background.

**Frame the problem** — lead with the "why" before the "what":

> "We all use ChatGPT, Claude, Gemini... but every conversation starts from zero.
> You're always re-explaining who you are, what you're working on, what you care about.
> Imagine if instead, you had an AI that already knew you."

This frames the entire talk. The audience immediately gets it — they've all felt that frustration.

### 2. What is a Personal Agent? (3 min)

High-level definition. Distinguish from:

- Chatbots (stateless, generic)
- Assistants (Siri, Alexa — limited, corporate-owned)
- Personal agents (persistent, extensible, yours)

Key message: A personal agent is an AI that **knows you, reaches you anywhere, and acts on your behalf**.

### 3. AI at beehiiv (5 min)

Establishes credibility — shows this isn't just a hobby project. Michael works with AI at scale professionally.

- How beehiiv uses AI in production
- What that experience taught about building reliable AI systems
- Bridge to: "...and that's what led me to build something personal"

**Audience note**: This section doubles as a "here's what AI looks like at scale in industry" — aspirational for a group just adopting Agile. Keep it concrete and relatable.

### 4. The Three Pillars (15 min)

**Tell mini-stories, not feature lists.** For a non-AI audience, stories land way harder.

#### Pillar 1: Accessibility

_Ability to communicate with your agent from anywhere_

> "I'm on my couch and I text Claudia on iMessage to remind me about something.
> Next morning I'm at my desk and pick up the same thread in the web UI.
> On a walk, I talk to her through voice on my phone."

Show: iMessage screenshot, web UI, iOS app, VS Code sidebar.
Same agent, everywhere. One brain, many interfaces.

Interfaces built:

- Web UI (browser)
- CLI (terminal)
- VS Code Extension (sidebar chat)
- macOS Menubar App (SwiftUI)
- iOS App (native Swift, voice mode)
- iMessage (text-based)
- Voice (Cartesia Sonic 3.0 real-time streaming TTS)

#### Pillar 2: Memory

_Ability to remember conversations automatically and recall as needed_

> "I never told Claudia to remember my preferences, my projects, my patterns.
> She has a librarian — we call her Libby — who reads every conversation and
> distills what matters: insights, milestones, timeline events."

This one will blow their minds. The agent builds a living profile WITHOUT you doing anything.

Memory system components:

- **Libby** (the librarian): Automated pipeline that processes conversations
- **Timeline capture**: Key events with dates, automatically extracted
- **Milestones**: Significant achievements and breakthroughs
- **Insights**: Patterns, preferences, working style observations
- **Recall**: Semantic search across all memories when relevant context is needed

Key message: The agent learns about you passively — you don't have to "train" it.

#### Pillar 3: Autonomy

_Ability to react without waiting for a prompt_

> "I don't always have to ask. Claudia runs scheduled tasks, reacts to webhooks,
> processes things in the background."

This is what separates a personal agent from a chatbot. Emphasize the distinction.

Examples:

- Heartbeat / scheduled jobs
- Webhook reactions
- Background processing (memory ingestion runs autonomously)
- Proactive notifications

### 5. Live Demo (15-20 min)

Prioritize **"wow that's magic"** moments over technical depth. Remember: most of this audience has only pasted code into ChatGPT — every demo step will feel like a leap.

**Demo flow:**

1. **Show Claude Code briefly** — quick terminal demo showing the foundation. "This is Claude Code — an AI coding agent that runs in your terminal. It can read files, write code, run commands. This is what I built on top of." (30-60 sec — gives them the on-ramp)

2. **Show the web UI** — send a message, get a response, show it's a real conversation (30 sec)

3. **Show memory recall** — ask Claudia something she'd only know from a past conversation. _"When did I start working on the layout system?"_ She answers from memory. Jaw-drop moment.

4. **Show iMessage** — text Claudia from your phone right there on stage. Response comes back. Audience sees it's real, it's everywhere.

5. **Show developer workflow** (if time) — briefly show how the agent fits into a real dev process: git hooks, automated checks, how Claudia commits code responsibly. Resonates with their Agile transition.

6. **Meta moment**: Reveal that the slide deck itself is a Claudia extension (see Extension Plan below).

### 6. Landscape + Closing (5 min)

- **OpenClaw**: The one everyone talks about — mention the broader movement
- **The ecosystem is growing**: Personal agents are becoming a thing
- **"You can do this too"** moment

**Close with something thought-provoking** (lands well with educators):

> "The question isn't whether AI will be personal.
> It's whether YOU'LL own that personal AI, or whether a company will own it for you."

Educators think about agency, ownership, student autonomy — this resonates.

### 7. Q&A (10-15 min)

Technical drill-down as needed. Be ready to go deeper on:

- Architecture (gateway, extensions, WebSocket protocol)
- Memory system internals
- How Claude Code CLI works under the hood
- Cost / infrastructure
- Privacy and data ownership

---

## Presentation Extension Plan

### The Meta Moment

The slide deck itself will be a Claudia extension — Michael presents a talk about Claudia **using an extension that Claudia built and is running**. During the demo:

> "By the way — this slide deck you're looking at? It's not PowerPoint. It's not Google Slides.
> It's a Claudia extension. I described what I wanted, she generated the slides as structured data,
> and this extension is rendering them right now on port 30086."

Could even add a slide in real-time during the presentation for maximum impact.

### Extension Architecture

Same pattern as audiobooks — structured data in, beautiful rendered output.

```
extensions/presentation/
  src/
    index.ts          # Server: presentation.list, presentation.get
    routes.ts         # Web: /present/:id
    panels/
      SlidePanel.tsx  # Slide renderer + navigation
    data/
      presentations/  # JSON slide decks
```

### Slide Data Format

```typescript
interface Presentation {
  id: string;
  title: string;
  author: string;
  theme?: "dark" | "light" | "claudia";
  slides: Slide[];
}

interface Slide {
  // Slide types for different visual layouts
  type: "title" | "section" | "bullets" | "code" | "quote" | "image" | "split" | "demo";
  title?: string;
  subtitle?: string;
  bullets?: (string | { text: string; sub?: string[] })[]; // nested bullets
  code?: { language: string; content: string; highlight?: number[] };
  quote?: { text: string; attribution?: string };
  image?: { src: string; alt: string; position?: "full" | "right" | "left" };
  notes?: string; // speaker notes (visible in presenter mode)
}
```

### Navigation & Features

- **Keyboard**: Arrow keys, Space, Escape
- **Presenter mode**: Split view — current slide + next slide + speaker notes (like Keynote)
- **Progress bar**: Subtle bottom bar showing position
- **Slide counter**: "12 / 34" in the corner
- **Touch/swipe**: For presenting from iPad/phone
- **URL-driven**: `/present/personal-agents#12` — deep-linkable to any slide

### What This Naturally Demonstrates

The extension itself showcases all three pillars without even trying:

1. **Accessibility** — runs in a browser, works on any device
2. **Memory** — Claudia generated the content because she knows the architecture, speaking style, and outline
3. **Autonomy** — the extension runs independently, serves the presentation without prompting

---

## Key Messages to Remember

- **Stories over features** — for this audience, always lead with a relatable scenario
- **The "cold start" problem** is the hook — everyone has felt it
- **Ownership** is the philosophical anchor — who owns your AI relationship?
- **Keep it high-level** — technical depth lives in Q&A, not the main talk
- **The meta moment** (presenting with Claudia) is the mic drop — save it for impact
