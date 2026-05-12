/**
 * Bogart state machine — the behavior FSM behind the animated pet cat.
 *
 * High-frequency render state (`frameIndex`, `posX`) stays in React because
 * it ticks at 6fps and flooding the machine would defeat its purpose. The
 * machine owns the things that have *meaning*: which top-level mood we're
 * in, which animation that translates to, which way the cat is facing, and
 * the timer-driven sequences (waking, settling, idle wandering, chasing).
 *
 * Events emitted by the React side:
 *   TYPING        — user is currently typing in the textarea
 *   QUERY_START   — a query just started (chase the yarn ball)
 *   QUERY_STOP    — query finished (settle back to idle)
 *   ANIM_FINISHED — frame ticker reached the last frame of a non-loop anim
 *   BOUNCE        — walking anim hit a container edge; payload has the new dir
 *
 * The machine emits no events; consumers read `snapshot.context.currentAnim`
 * and `snapshot.context.direction` to drive rendering.
 */

import { assign, setup } from "xstate";

// ── Animation catalog ─────────────────────────────────────────────────────
// Kept here (not in Bogart.tsx) because the settling sequence needs to know
// each anim's duration to schedule the next transition. Sprite-rendering
// (frames, baselines, sheet index) is what the component file owns.

export interface AnimDef {
  sheet: number;
  frames: readonly number[];
  loop: boolean;
  movement: "right" | "left" | "none";
}

export const FPS = 6;

export const ANIMS = {
  "walk-right": { sheet: 0, frames: [4, 5, 6, 7], loop: true, movement: "right" },
  "walk-left": { sheet: 0, frames: [12, 13, 14, 15], loop: true, movement: "left" },
  sit: { sheet: 0, frames: [16, 17, 18, 19], loop: false, movement: "none" },
  "lick-paw": { sheet: 0, frames: [20, 21, 22, 23], loop: false, movement: "none" },
  sleep: { sheet: 2, frames: [0, 1, 2, 3], loop: true, movement: "none" },
  stir: { sheet: 2, frames: [4, 5, 6, 7], loop: false, movement: "none" },
  stand: { sheet: 2, frames: [8, 9, 10, 11], loop: false, movement: "none" },
  stretch: { sheet: 2, frames: [12, 13, 14, 15, 15, 15, 15], loop: false, movement: "none" },
  "walk-right-2": { sheet: 2, frames: [16, 19, 20, 21, 22, 23], loop: true, movement: "right" },
  "chase-yarn": {
    sheet: 1,
    frames: [0, 1, 2, 3, 7, 5, 4, 6, 11, 10, 9, 8, 12, 13, 14, 15, 19, 18, 17, 16, 20, 21, 22, 23],
    loop: true,
    movement: "none",
  },
} as const satisfies Record<string, AnimDef>;

export type AnimName = keyof typeof ANIMS;

const animDurationMs = (name: AnimName): number => (ANIMS[name].frames.length / FPS) * 1000;

// ── Timings (replicates the old `playChain` schedule and idle/chase loops) ──

const IDLE_SLEEP_TIMEOUT = 30_000;
const IDLE_ACTION_MIN = 10_000;
const IDLE_ACTION_RANGE = 10_000;
const CHASE_SWITCH_MIN = 4_000;
const CHASE_SWITCH_RANGE = 3_000;
const WALK_DURATION = 3_000;

// settling: sit → pause 8s → lick-paw → pause 3s → stretch → sleeping
const SETTLING_SIT_HOLD = animDurationMs("sit") + 8_000;
const SETTLING_LICK_HOLD = animDurationMs("lick-paw") + 3_000;
const SETTLING_STRETCH_HOLD = animDurationMs("stretch");

// idle.lickPaw / idle.stretchAction: short pause after the anim finishes
const IDLE_LICK_HOLD = animDurationMs("lick-paw") + 1_500;
const IDLE_STRETCH_HOLD = animDurationMs("stretch") + 1_000;

// ── Context + events ──────────────────────────────────────────────────────

export interface BogartContext {
  currentAnim: AnimName;
  direction: 1 | -1;
  /** Random roll captured when deciding the next random branch (idle / chase). */
  roll: number;
}

export type BogartEvent =
  | { type: "TYPING" }
  | { type: "QUERY_START" }
  | { type: "QUERY_STOP" }
  | { type: "ANIM_FINISHED" }
  | { type: "BOUNCE"; nextDir: 1 | -1 };

// ── Machine ───────────────────────────────────────────────────────────────

export const bogartMachine = setup({
  types: {
    context: {} as BogartContext,
    events: {} as BogartEvent,
  },
  actions: {
    setAnim: assign((_, params: { name: AnimName }) => ({ currentAnim: params.name })),
    setDirection: assign((_, params: { direction: 1 | -1 }) => ({ direction: params.direction })),
    randomDirection: assign({
      direction: (): 1 | -1 => (Math.random() > 0.5 ? 1 : -1),
    }),
    /** Pick the appropriate walk animation based on current direction. */
    playWalkAnim: assign(({ context }) => ({
      currentAnim: (context.direction === 1 ? "walk-right" : "walk-left") as AnimName,
    })),
    /** Capture one random value to be inspected by the branch guards below. */
    rollRandom: assign({ roll: () => Math.random() }),
    /** Bounce: flip direction from the event payload (frame ticker decides). */
    applyBounceDirection: assign((_, params: { nextDir: 1 | -1 }) => ({
      direction: params.nextDir,
    })),
  },
  guards: {
    rollLickPaw: ({ context }) => context.roll < 0.25,
    rollStretch: ({ context }) => context.roll < 0.4,
    rollWalk: ({ context }) => context.roll < 0.6,
    rollYarn: ({ context }) => context.roll < 0.4,
  },
  delays: {
    randomIdleAction: () => IDLE_ACTION_MIN + Math.random() * IDLE_ACTION_RANGE,
    randomChaseSwitch: () => CHASE_SWITCH_MIN + Math.random() * CHASE_SWITCH_RANGE,
  },
}).createMachine({
  id: "bogart",
  initial: "sleeping",
  context: {
    currentAnim: "sleep",
    direction: 1,
    roll: 0,
  },
  // Global: any query start preempts whatever we're doing.
  on: {
    QUERY_START: { target: ".chasing" },
  },
  states: {
    sleeping: {
      entry: { type: "setAnim", params: { name: "sleep" } },
      on: { TYPING: "waking" },
    },

    // waking: stir → stretch → stand → idle, each driven by ANIM_FINISHED
    waking: {
      initial: "stir",
      states: {
        stir: {
          entry: { type: "setAnim", params: { name: "stir" } },
          on: { ANIM_FINISHED: "stretch" },
        },
        stretch: {
          entry: { type: "setAnim", params: { name: "stretch" } },
          on: { ANIM_FINISHED: "stand" },
        },
        stand: {
          entry: { type: "setAnim", params: { name: "stand" } },
          on: { ANIM_FINISHED: "#bogart.idle" },
        },
      },
    },

    // settling: sit → 8s → lick-paw → 3s → stretch → sleeping
    settling: {
      initial: "sit",
      // If the user wakes the cat mid-settle, abort and play the wake sequence.
      on: { TYPING: "waking" },
      states: {
        sit: {
          entry: { type: "setAnim", params: { name: "sit" } },
          after: { [SETTLING_SIT_HOLD]: "lickPaw" },
        },
        lickPaw: {
          entry: { type: "setAnim", params: { name: "lick-paw" } },
          after: { [SETTLING_LICK_HOLD]: "stretch" },
        },
        stretch: {
          entry: { type: "setAnim", params: { name: "stretch" } },
          after: { [SETTLING_STRETCH_HOLD]: "#bogart.sleeping" },
        },
      },
    },

    // idle: sit, occasionally do random actions, eventually settle.
    idle: {
      initial: "sitting",
      // 30s of total idle (no typing) → settle. Re-entering idle.* resets this.
      after: {
        [IDLE_SLEEP_TIMEOUT]: "settling",
      },
      on: {
        // Typing while idle pings the idle timer by re-entering the parent.
        TYPING: { target: ".sitting", reenter: true },
      },
      states: {
        sitting: {
          entry: { type: "setAnim", params: { name: "sit" } },
          after: {
            randomIdleAction: {
              target: "deciding",
              actions: "rollRandom",
            },
          },
        },
        // Eventless transient state that branches on the captured roll.
        deciding: {
          always: [
            { target: "lickPaw", guard: "rollLickPaw" },
            { target: "doingStretch", guard: "rollStretch" },
            { target: "walking", guard: "rollWalk", actions: "randomDirection" },
            // 40% chance of doing nothing — back to sitting.
            { target: "sitting" },
          ],
        },
        lickPaw: {
          entry: { type: "setAnim", params: { name: "lick-paw" } },
          // Old playChain held this slot for animDuration + 1.5s before sitting again.
          after: { [IDLE_LICK_HOLD]: "sitting" },
        },
        doingStretch: {
          entry: { type: "setAnim", params: { name: "stretch" } },
          after: { [IDLE_STRETCH_HOLD]: "sitting" },
        },
        walking: {
          entry: "playWalkAnim",
          after: { [WALK_DURATION]: "sitting" },
          on: {
            BOUNCE: {
              target: "walking",
              reenter: true,
              actions: [
                {
                  type: "applyBounceDirection",
                  params: ({ event }) => ({ nextDir: event.nextDir }),
                },
              ],
            },
          },
        },
      },
    },

    // chasing: switch between yarn-chasing and walking every 4-7s.
    chasing: {
      initial: "deciding",
      on: { QUERY_STOP: "idle" },
      states: {
        deciding: {
          entry: "rollRandom",
          always: [
            { target: "yarn", guard: "rollYarn" },
            { target: "walking", actions: "randomDirection" },
          ],
        },
        yarn: {
          entry: { type: "setAnim", params: { name: "chase-yarn" } },
          after: { randomChaseSwitch: "deciding" },
        },
        walking: {
          entry: "playWalkAnim",
          after: { randomChaseSwitch: "deciding" },
          on: {
            BOUNCE: {
              target: "walking",
              reenter: true,
              actions: [
                {
                  type: "applyBounceDirection",
                  params: ({ event }) => ({ nextDir: event.nextDir }),
                },
              ],
            },
          },
        },
      },
    },
  },
});
