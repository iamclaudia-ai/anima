/**
 * Bogart — Animated pet cat companion for the chat UI.
 *
 * A pixel-art calico cat that lives on top of the textarea,
 * reacting to chat state with different animations:
 *   - Idle: sits, occasionally licks paw
 *   - User typing: perks up, looks alert
 *   - Thinking/querying: chases yarn ball across the textarea
 *   - Idle timeout: curls up and sleeps
 *   - Wake up: stir → stretch → stand sequence
 *
 * Sprites: 416×416 frames from 3 sheets (4 cols × 6 rows).
 * Baselines align shadows so animations transition smoothly.
 *
 * The behavior FSM lives in `./Bogart.machine.ts` — this file owns rendering,
 * the frame ticker, and the prop→event bridge.
 */

import { useEffect, useReducer, useRef, type CSSProperties } from "react";
import { useMachine } from "@xstate/react";

import { ANIMS, FPS, bogartMachine } from "./Bogart.machine";

// Sprite sheets are colocated with this component under packages/ui/static/.
// Bun's bundler emits each .png as a hashed asset and resolves these imports
// to URLs (e.g. "/assets/sprite1-<hash>.png") served by the gateway's asset
// route. Content-addressed → automatic cache busting.
import sprite1Url from "../../static/bogart/sprite1.png";
import sprite2Url from "../../static/bogart/sprite2.png";
import sprite3Url from "../../static/bogart/sprite3.png";

// ── Sprite config ──────────────────────────────────────────
const COLS = 4;
const FRAME_W = 416;
const FRAME_H = 416;

// Display size — scale down for the UI (416px is huge)
const DISPLAY_SCALE = 0.15; // ~62px tall
const DISPLAY_W = FRAME_W * DISPLAY_SCALE;
const DISPLAY_H = FRAME_H * DISPLAY_SCALE;

const BOGART_CONTAINER_STATIC: CSSProperties = {
  position: "absolute",
  bottom: "100%",
  width: DISPLAY_W,
  height: DISPLAY_H,
  pointerEvents: "none",
  zIndex: 10,
  overflow: "hidden",
  transition: "left 0.05s linear",
};

/**
 * Bogart sprite sheet URLs, exported so consumers (e.g. the bogart
 * scratchpad page) can reference them without re-importing the binary.
 */
export const BOGART_SPRITE_URLS = [sprite1Url, sprite2Url, sprite3Url] as const;

const SHEETS = [
  { src: sprite1Url, baselines: [301, 301, 305, 307, 310, 315] },
  { src: sprite2Url, baselines: [302, 305, 316, 313, 312, 313] },
  { src: sprite3Url, baselines: [307, 308, 308, 309, 314, 316] },
];

const MAX_BASELINE = Math.max(...SHEETS.flatMap((s) => s.baselines));

const WALK_SPEED = 1.5; // pixels per frame

// ── Props ──────────────────────────────────────────────────
interface BogartProps {
  isQuerying: boolean;
  isTyping: boolean;
  containerWidth: number;
}

// ── Render-tick reducer ────────────────────────────────────
// frameIndex + posX both tick at 6fps in lockstep, so they share a reducer.
// Keeping the per-tick logic pure here means the ticker effect only contains
// one dispatch, and `send` side-effects live in the React effect body (not
// inside a setState updater).

interface TickState {
  frame: number;
  posX: number;
}

type TickAction = { type: "reset"; posX?: number } | { type: "set"; state: TickState };

function tickReducer(prev: TickState, action: TickAction): TickState {
  switch (action.type) {
    case "reset":
      return { frame: 0, posX: action.posX ?? prev.posX };
    case "set":
      return action.state;
  }
}

// ── Component ──────────────────────────────────────────────
export function Bogart({ isQuerying, isTyping, containerWidth }: BogartProps) {
  const [snapshot, send] = useMachine(bogartMachine);
  const { currentAnim, direction } = snapshot.context;

  // Frame-rate state stays in React (ticking it through the machine would
  // mean a 6Hz event per Bogart and defeat the point). `frame` and `posX`
  // share a reducer because they always update together.
  const [tick, dispatchTick] = useReducer(tickReducer, { frame: 0, posX: 20 });

  // Track whether we've already dispatched ANIM_FINISHED for the current
  // animation, so we don't flood the machine while sitting on the last frame.
  const animFinishedRef = useRef(false);

  // ── Prop → event bridge ──────────────────────────────────
  // `snapshot.value` is part of the deps so transitions re-fire this effect
  // and we can re-send TYPING when state changes mid-typing — that preserves
  // the old behavior where landing in `idle` while still typing would reset
  // the 30s idle-sleep timer.
  useEffect(() => {
    if (isTyping) send({ type: "TYPING" });
    if (isQuerying) send({ type: "QUERY_START" });
    else send({ type: "QUERY_STOP" });
  }, [isTyping, isQuerying, snapshot.value, send]);

  // Reset per-anim render state whenever the machine picks a new clip.
  useEffect(() => {
    animFinishedRef.current = false;
    dispatchTick({ type: "reset" });
  }, [currentAnim]);

  // Keep a ref of the current tick so the setInterval body can compute the
  // next state from the freshest value without going through a setState
  // updater (which forbids side-effecty `send` calls).
  const tickRef = useRef(tick);
  tickRef.current = tick;

  // ── Frame ticker ─────────────────────────────────────────
  // Runs at 6 FPS, advancing frame and (for walking anims) posX. Emits
  // ANIM_FINISHED when a non-looping animation reaches its last frame, and
  // BOUNCE when a walking animation hits a container edge.
  useEffect(() => {
    const anim = ANIMS[currentAnim];
    const totalFrames = anim.frames.length;

    const interval = setInterval(() => {
      const prev = tickRef.current;
      const nextFrame = anim.loop
        ? (prev.frame + 1) % totalFrames
        : Math.min(prev.frame + 1, totalFrames - 1);
      const reachedEnd = !anim.loop && nextFrame === totalFrames - 1;
      if (reachedEnd && !animFinishedRef.current) {
        animFinishedRef.current = true;
        send({ type: "ANIM_FINISHED" });
      }

      let nextPosX = prev.posX;
      if (anim.movement !== "none") {
        const dir = anim.movement === "right" ? 1 : -1;
        nextPosX = prev.posX + WALK_SPEED * dir;
        const maxX = containerWidth - DISPLAY_W - 10;
        if (nextPosX >= maxX) {
          nextPosX = maxX;
          send({ type: "BOUNCE", nextDir: -1 });
        } else if (nextPosX <= 10) {
          nextPosX = 10;
          send({ type: "BOUNCE", nextDir: 1 });
        }
      }

      dispatchTick({ type: "set", state: { frame: nextFrame, posX: nextPosX } });
    }, 1000 / FPS);

    return () => clearInterval(interval);
  }, [currentAnim, containerWidth, send]);

  // ── Rendering ────────────────────────────────────────────
  const anim = ANIMS[currentAnim];
  const sheet = SHEETS[anim.sheet];
  const frameIdx = anim.frames[tick.frame % anim.frames.length];
  const col = frameIdx % COLS;
  const row = Math.floor(frameIdx / COLS);
  const baseline = sheet.baselines[row];
  const baselineShift = (MAX_BASELINE - baseline) * DISPLAY_SCALE;

  // `direction` is part of context but the visible direction is encoded in the
  // currentAnim (walk-right vs walk-left), so we don't need it to render —
  // reference it so the linter doesn't drop the destructure.
  void direction;

  return (
    <div
      style={{
        ...BOGART_CONTAINER_STATIC,
        left: tick.posX,
        marginBottom: -8 + baselineShift, // overlap textarea edge slightly
      }}
    >
      <div
        style={{
          width: DISPLAY_W,
          height: DISPLAY_H,
          backgroundImage: `url(${sheet.src})`,
          backgroundPosition: `-${col * FRAME_W * DISPLAY_SCALE}px -${row * FRAME_H * DISPLAY_SCALE}px`,
          backgroundSize: `${1664 * DISPLAY_SCALE}px ${2570 * DISPLAY_SCALE}px`,
          imageRendering: "pixelated",
        }}
      />
    </div>
  );
}
