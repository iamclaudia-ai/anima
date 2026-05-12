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

import {
  useState,
  useEffect,
  useEffectEvent,
  useRef,
  useCallback,
  type CSSProperties,
} from "react";

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

// ── Animation definitions ──────────────────────────────────
// movement: "right" | "left" | "none" — whether the sprite moves during this animation
// loop: true = repeats until state changes, false = plays once then stops on last frame
interface AnimDef {
  sheet: number;
  frames: readonly number[];
  loop: boolean;
  movement: "right" | "left" | "none";
}

const ANIMS: Record<string, AnimDef> = {
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
};

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
      // Randomly pick between chase-yarn (stays put) and walking
      const roll = Math.random();
      if (roll < 0.4) {
        playAnim("chase-yarn");
      } else {
        const walkDir = Math.random() > 0.5 ? "walk-right" : "walk-left";
        setDirection(walkDir === "walk-right" ? 1 : -1);
        playAnim(walkDir);
      }
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

  // ── Chain helper: play animations with delays between them ─
  const chainTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearChain = useCallback(() => {
    for (const t of chainTimersRef.current) clearTimeout(t);
    chainTimersRef.current = [];
  }, []);

  // A chain step is either an animation name or a delay in ms
  type ChainStep = AnimName | number;

  const playChain = useCallback(
    (steps: ChainStep[], onDone?: () => void) => {
      clearChain();
      let delay = 0;

      for (const step of steps) {
        if (typeof step === "number") {
          delay += step;
        } else {
          const anim = step;
          const animDuration = (ANIMS[anim].frames.length / FPS) * 1000;
          const t = setTimeout(() => {
            if (stateRef.current === "settling" || stateRef.current === "idle") {
              playAnim(anim);
            }
          }, delay);
          chainTimersRef.current.push(t);
          delay += animDuration;
        }
      }

      if (onDone) {
        const t = setTimeout(() => onDone(), delay);
        chainTimersRef.current.push(t);
      }
    },
    [clearChain, playAnim],
  );

  // ── Settling → sleep ─────────────────────────────────────
  // sit → (pause 8s) → lick-paw → (pause 3s) → stretch → sleep
  useEffect(() => {
    if (state === "settling") {
      playChain(["sit", 8000, "lick-paw", 3000, "stretch"], () => {
        setState("sleeping");
        playAnim("sleep");
      });
      return () => clearChain();
    }
  }, [state, playAnim, playChain, clearChain]);

  // ── Idle behavior: occasional random animations ──────────
  // `playChain` is only called inside the setInterval, so it doesn't need to
  // be a reactive dep — wrap the tick in `useEffectEvent` so identity changes
  // to `playChain` don't tear down/recreate the interval.
  const onIdleTick = useEffectEvent(() => {
    if (stateRef.current !== "idle") return;
    const roll = Math.random();
    if (roll < 0.25) {
      // Lick paw then sit again
      playChain(["lick-paw", 1500, "sit"]);
    } else if (roll < 0.4) {
      // Stretch then sit
      playChain(["stretch", 1000, "sit"]);
    } else if (roll < 0.6) {
      // Short walk
      setState("walking");
      setDirection(Math.random() > 0.5 ? 1 : -1);
      setTimeout(() => {
        if (stateRef.current === "walking") {
          setState("idle");
        }
      }, 3000);
    }
    // else: just keep sitting (40% chance of doing nothing)
  });

  useEffect(() => {
    if (state === "idle") {
      playAnim("sit");
      resetIdleTimer();

      // Random idle actions every 10-20 seconds
      const idleAction = setInterval(onIdleTick, 10000 + Math.random() * 10000);

      return () => {
        clearInterval(idleAction);
        clearChain();
      };
    }
  }, [state, playAnim, clearChain, resetIdleTimer]);

  // ── Chasing behavior: switch between yarn and walking ────
  // `playAnim` is only invoked inside the setInterval, so wrap the tick in
  // `useEffectEvent` and drop it from the effect's reactive deps.
  const onChasingTick = useEffectEvent(() => {
    if (stateRef.current !== "chasing") return;
    const roll = Math.random();
    if (roll < 0.4) {
      playAnim("chase-yarn");
    } else {
      const walkDir = Math.random() > 0.5 ? "walk-right" : "walk-left";
      setDirection(walkDir === "walk-right" ? 1 : -1);
      playAnim(walkDir);
    }
  });

  useEffect(() => {
    if (state !== "chasing") return;
    const switchAnim = setInterval(onChasingTick, 4000 + Math.random() * 3000);
    return () => clearInterval(switchAnim);
  }, [state]);

  // ── Walking state ────────────────────────────────────────
  useEffect(() => {
    if (state === "walking") {
      playAnim(direction === 1 ? "walk-right" : "walk-left");
    }
  }, [state, direction, playAnim]);

  // Sync direction when walk animation bounces off edge
  useEffect(() => {
    if (currentAnim === "walk-right") setDirection(1);
    else if (currentAnim === "walk-left") setDirection(-1);
  }, [currentAnim]);

  // ── Frame ticker ─────────────────────────────────────────
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);

    const anim = ANIMS[currentAnim];
    const totalFrames = anim.frames.length;

    intervalRef.current = setInterval(() => {
      setFrameIndex((prev) => {
        const isLastFrame = prev === totalFrames - 1;

        // Non-looping animation reached the end
        if (isLastFrame && !anim.loop) {
          // Check if we're in a sequence
          if (sequenceRef.current.length > 0) {
            const seqAnims = sequenceRef.current as AnimName[] & { onDone?: () => void };
            sequenceIdxRef.current++;
            if (sequenceIdxRef.current < seqAnims.length) {
              const nextAnim = seqAnims[sequenceIdxRef.current];
              setCurrentAnim(nextAnim);
              return 0;
            }
            // Sequence complete
            sequenceRef.current = [];
            sequenceIdxRef.current = 0;
            seqAnims.onDone?.();
          }
          // Stay on last frame
          return prev;
        }

        const next = (prev + 1) % totalFrames;

        // Looping animation completed a cycle — check sequence
        if (next === 0 && anim.loop && sequenceRef.current.length > 0) {
          const seqAnims = sequenceRef.current as AnimName[] & { onDone?: () => void };
          sequenceIdxRef.current++;
          if (sequenceIdxRef.current < seqAnims.length) {
            const nextAnim = seqAnims[sequenceIdxRef.current];
            setCurrentAnim(nextAnim);
            return 0;
          }
          sequenceRef.current = [];
          sequenceIdxRef.current = 0;
          seqAnims.onDone?.();
        }

        return next;
      });

      // Movement — driven by the animation's movement property
      const movement = ANIMS[currentAnim].movement;
      if (movement !== "none") {
        const dir = movement === "right" ? 1 : -1;
        setPosX((prev) => {
          let next = prev + WALK_SPEED * dir;

          // Bounce off edges
          const maxX = containerWidth - DISPLAY_W - 10;
          if (next >= maxX) {
            next = maxX;
            setDirection(-1);
            playAnim("walk-left");
          } else if (next <= 10) {
            next = 10;
            setDirection(1);
            playAnim("walk-right");
          }
          return next;
        });
      }
    }, 1000 / FPS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [currentAnim, containerWidth, playAnim]);

  // ── Rendering ────────────────────────────────────────────
  const anim = ANIMS[currentAnim];
  const sheet = SHEETS[anim.sheet];
  const frameIdx = anim.frames[frameIndex % anim.frames.length];
  const col = frameIdx % COLS;
  const row = Math.floor(frameIdx / COLS);
  const baseline = sheet.baselines[row];
  const baselineShift = (MAX_BASELINE - baseline) * DISPLAY_SCALE;

  return (
    <div
      style={{
        ...BOGART_CONTAINER_STATIC,
        left: posX,
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
