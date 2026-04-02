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
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ── Sprite config ──────────────────────────────────────────
const COLS = 4;
const FRAME_W = 416;
const FRAME_H = 416;

// Display size — scale down for the UI (416px is huge)
const DISPLAY_SCALE = 0.15; // ~62px tall
const DISPLAY_W = FRAME_W * DISPLAY_SCALE;
const DISPLAY_H = FRAME_H * DISPLAY_SCALE;

const SHEETS = [
  { src: "/bogart/sprites/sprite1.png", baselines: [301, 301, 305, 307, 310, 315] },
  { src: "/bogart/sprites/sprite2.png", baselines: [302, 305, 316, 313, 312, 313] },
  { src: "/bogart/sprites/sprite3.png", baselines: [307, 308, 308, 309, 314, 316] },
];

const MAX_BASELINE = Math.max(...SHEETS.flatMap((s) => s.baselines));

// ── Animation definitions ──────────────────────────────────
const ANIMS = {
  "walk-right": { sheet: 0, frames: [4, 5, 6, 7] },
  "walk-left": { sheet: 0, frames: [12, 13, 14, 15] },
  sit: { sheet: 0, frames: [16, 17, 18, 19] },
  "lick-paw": { sheet: 0, frames: [20, 21, 22, 23] },
  sleep: { sheet: 2, frames: [0, 1, 2, 3] },
  stir: { sheet: 2, frames: [4, 5, 6, 7] },
  stand: { sheet: 2, frames: [8, 9, 10, 11] },
  stretch: { sheet: 2, frames: [12, 13, 14, 15] },
  "walk-right-2": { sheet: 2, frames: [16, 19, 20, 21, 22, 23] },
  "chase-yarn": {
    sheet: 1,
    frames: [0, 1, 2, 3, 7, 5, 4, 6, 11, 10, 9, 8, 12, 13, 14, 15, 19, 18, 17, 16, 20, 21, 22, 23],
  },
} as const;

type AnimName = keyof typeof ANIMS;

// ── State machine ──────────────────────────────────────────
type BogartState = "sleeping" | "waking" | "idle" | "walking" | "chasing" | "settling";

const FPS = 6;
const IDLE_SLEEP_TIMEOUT = 30_000; // sleep after 30s idle
const WALK_SPEED = 1.5; // pixels per frame

// ── Props ──────────────────────────────────────────────────
interface BogartProps {
  isQuerying: boolean;
  isTyping: boolean;
  containerWidth: number;
}

// ── Component ──────────────────────────────────────────────
export function Bogart({ isQuerying, isTyping, containerWidth }: BogartProps) {
  const [state, setState] = useState<BogartState>("sleeping");
  const [currentAnim, setCurrentAnim] = useState<AnimName>("sleep");
  const [frameIndex, setFrameIndex] = useState(0);
  const [posX, setPosX] = useState(20); // horizontal position
  const [direction, setDirection] = useState<1 | -1>(1); // 1 = right, -1 = left

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  const sequenceRef = useRef<AnimName[]>([]);
  const sequenceIdxRef = useRef(0);

  stateRef.current = state;

  // ── Play an animation ────────────────────────────────────
  const playAnim = useCallback((name: AnimName) => {
    setCurrentAnim(name);
    setFrameIndex(0);
  }, []);

  // ── Play a sequence of animations ────────────────────────
  const playSequence = useCallback(
    (anims: AnimName[], thenState: BogartState) => {
      sequenceRef.current = anims;
      sequenceIdxRef.current = 0;
      playAnim(anims[0]);

      // We'll advance in the frame ticker when the current anim finishes a loop
      const onSequenceDone = () => setState(thenState);
      // Store callback on ref
      (sequenceRef as { current: AnimName[] & { onDone?: () => void } }).current.onDone =
        onSequenceDone;
    },
    [playAnim],
  );

  // ── Reset idle timer ─────────────────────────────────────
  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      if (stateRef.current === "idle") {
        setState("settling");
      }
    }, IDLE_SLEEP_TIMEOUT);
  }, []);

  // ── State transitions based on props ─────────────────────
  useEffect(() => {
    if (isQuerying && state !== "chasing") {
      setState("chasing");
      setDirection(1);
      playAnim("chase-yarn");
    } else if (isTyping && (state === "sleeping" || state === "settling")) {
      setState("waking");
      playSequence(["stir", "stretch", "stand"], "idle");
    } else if (isTyping && state === "idle") {
      // Already awake, just reset idle timer
      resetIdleTimer();
    } else if (!isQuerying && state === "chasing") {
      setState("idle");
      playAnim("sit");
      resetIdleTimer();
    }
  }, [isQuerying, isTyping, state, playAnim, playSequence, resetIdleTimer]);

  // ── Settling → sleep ─────────────────────────────────────
  useEffect(() => {
    if (state === "settling") {
      playAnim("lick-paw");
      // After one lick-paw cycle, go to sleep
      const timer = setTimeout(
        () => {
          setState("sleeping");
          playAnim("sleep");
        },
        (ANIMS["lick-paw"].frames.length / FPS) * 1000,
      );
      return () => clearTimeout(timer);
    }
  }, [state, playAnim]);

  // ── Idle behavior: occasional random animations ──────────
  useEffect(() => {
    if (state === "idle") {
      playAnim("sit");
      resetIdleTimer();

      // Random idle actions every 8-15 seconds
      const idleAction = setInterval(
        () => {
          if (stateRef.current !== "idle") return;
          const roll = Math.random();
          if (roll < 0.3) {
            playAnim("lick-paw");
            setTimeout(
              () => {
                if (stateRef.current === "idle") playAnim("sit");
              },
              (ANIMS["lick-paw"].frames.length / FPS) * 1000,
            );
          } else if (roll < 0.5) {
            // Short walk
            setState("walking");
            setDirection(Math.random() > 0.5 ? 1 : -1);
            setTimeout(() => {
              if (stateRef.current === "walking") {
                setState("idle");
              }
            }, 3000);
          }
        },
        8000 + Math.random() * 7000,
      );

      return () => clearInterval(idleAction);
    }
  }, [state, playAnim, resetIdleTimer]);

  // ── Walking state ────────────────────────────────────────
  useEffect(() => {
    if (state === "walking") {
      playAnim(direction === 1 ? "walk-right" : "walk-left");
    }
  }, [state, direction, playAnim]);

  // ── Frame ticker ─────────────────────────────────────────
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);

    const anim = ANIMS[currentAnim];
    const totalFrames = anim.frames.length;

    intervalRef.current = setInterval(() => {
      setFrameIndex((prev) => {
        const next = (prev + 1) % totalFrames;

        // Check if we completed a cycle and are in a sequence
        if (next === 0 && sequenceRef.current.length > 0) {
          const seqAnims = sequenceRef.current as AnimName[] & { onDone?: () => void };
          sequenceIdxRef.current++;
          if (sequenceIdxRef.current < seqAnims.length) {
            // Advance to next animation in sequence
            const nextAnim = seqAnims[sequenceIdxRef.current];
            setCurrentAnim(nextAnim);
            return 0;
          }
          // Sequence complete
          sequenceRef.current = [];
          sequenceIdxRef.current = 0;
          seqAnims.onDone?.();
        }

        return next;
      });

      // Movement for walking/chasing states
      if (stateRef.current === "walking" || stateRef.current === "chasing") {
        setPosX((prev) => {
          const speed = stateRef.current === "chasing" ? WALK_SPEED * 2 : WALK_SPEED;
          let next = prev + speed * (stateRef.current === "chasing" ? direction : direction);

          // Bounce off edges
          const maxX = containerWidth - DISPLAY_W - 10;
          if (next >= maxX) {
            next = maxX;
            setDirection(-1);
            if (stateRef.current === "chasing") {
              // Don't change anim — chase-yarn handles all directions
            } else {
              playAnim("walk-left");
            }
          } else if (next <= 10) {
            next = 10;
            setDirection(1);
            if (stateRef.current !== "chasing") {
              playAnim("walk-right");
            }
          }
          return next;
        });
      }
    }, 1000 / FPS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [currentAnim, containerWidth, direction, playAnim]);

  // ── Rendering ────────────────────────────────────────────
  const anim = ANIMS[currentAnim];
  const sheet = SHEETS[anim.sheet];
  const frameIdx = anim.frames[frameIndex % anim.frames.length];
  const col = frameIdx % COLS;
  const row = Math.floor(frameIdx / COLS);
  const baseline = sheet.baselines[row];
  const baselineShift = (MAX_BASELINE - baseline) * DISPLAY_SCALE;

  // Flip horizontally for chasing when moving left
  const shouldFlip = state === "chasing" && direction === -1;

  return (
    <div
      style={{
        position: "absolute",
        bottom: "100%",
        left: posX,
        width: DISPLAY_W,
        height: DISPLAY_H,
        marginBottom: -8 + baselineShift, // overlap textarea edge slightly
        pointerEvents: "none",
        zIndex: 10,
        overflow: "hidden",
        transform: shouldFlip ? "scaleX(-1)" : undefined,
        transition: "left 0.05s linear",
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
