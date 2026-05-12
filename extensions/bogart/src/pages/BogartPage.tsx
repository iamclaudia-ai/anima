/**
 * Bogart Sprite Editor
 *
 * Preview and define animation sequences from sprite sheets.
 * Each sprite sheet is 4 columns × 6 rows = 24 frames.
 * Frame 0 = top-left, Frame 23 = bottom-right.
 *
 * Fixed frame size: 418w × 428h (extra pixels at sheet edges ignored).
 * Row N starts at Y = N * 428 in the sprite sheet.
 *
 * Shadow baselines were computed by scanning each row from the bottom
 * upward to find the first non-white pixel (the shadow edge).
 * All frames in a row share the same baseline.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { BOGART_SPRITE_URLS } from "@anima/ui";

// ── Sprite sheet config ────────────────────────────────────
const COLS = 4;
const ROWS = 6;
const TOTAL_FRAMES = COLS * ROWS;
const FRAME_W = 416;
const FRAME_H = 416;

// Sprite URLs come from @anima/ui — the production Bogart component imports
// the PNGs as JS modules, so we get the same hashed asset URLs here without
// duplicating the bytes into this extension's bundle.
const SPRITE_SHEETS = [
  {
    name: "Sheet 1",
    src: BOGART_SPRITE_URLS[0],
    // Shadow bottom Y within each frame (pixels from top of frame)
    // Scanned with 416×416 grid at x=208, bottom-up
    baselines: [301, 301, 305, 307, 310, 315],
  },
  {
    name: "Sheet 2",
    src: BOGART_SPRITE_URLS[1],
    baselines: [302, 305, 316, 313, 312, 313],
  },
  {
    name: "Sheet 3",
    src: BOGART_SPRITE_URLS[2],
    baselines: [307, 308, 308, 309, 314, 316],
  },
];

// Maximum baseline across all sheets/rows — used as the alignment anchor.
// Frames with a smaller baseline get pushed down so shadows line up.
const MAX_BASELINE = Math.max(...SPRITE_SHEETS.flatMap((s) => s.baselines));

// ── Types ──────────────────────────────────────────────────
interface AnimationDef {
  name: string;
  sheet: number;
  frames: number[];
}

// ── Predefined animations (editable) ───────────────────────
const DEFAULT_ANIMATIONS: AnimationDef[] = [
  { name: "All Frames (Sheet 1)", sheet: 0, frames: Array.from({ length: 24 }, (_, i) => i) },
  { name: "All Frames (Sheet 2)", sheet: 1, frames: Array.from({ length: 24 }, (_, i) => i) },
  { name: "All Frames (Sheet 3)", sheet: 2, frames: Array.from({ length: 24 }, (_, i) => i) },
];

// ── Component ──────────────────────────────────────────────
export function BogartPage() {
  const [selectedSheet, setSelectedSheet] = useState(0);
  const [fps, setFps] = useState(6);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedFrames, setSelectedFrames] = useState<number[]>([]);
  const [animations, setAnimations] = useState<AnimationDef[]>(DEFAULT_ANIMATIONS);
  const [activeAnimation, setActiveAnimation] = useState<AnimationDef | null>(null);
  const [newAnimName, setNewAnimName] = useState("");
  const [sheetDimensions, setSheetDimensions] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [showGrid, setShowGrid] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load sheet dimensions (for background-size)
  useEffect(() => {
    const img = new Image();
    img.onload = () => setSheetDimensions({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = SPRITE_SHEETS[selectedSheet].src;
  }, [selectedSheet]);

  const displayW = FRAME_W * zoom;
  const displayH = FRAME_H * zoom;

  // Animation playback
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);

    if (isPlaying && activeAnimation && activeAnimation.frames.length > 0) {
      let idx = 0;
      setCurrentFrame(activeAnimation.frames[0]);
      intervalRef.current = setInterval(() => {
        idx = (idx + 1) % activeAnimation.frames.length;
        setCurrentFrame(activeAnimation.frames[idx]);
      }, 1000 / fps);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying, fps, activeAnimation]);

  // Frame click handler for the grid
  const toggleFrame = useCallback((frameIdx: number) => {
    setSelectedFrames((prev) => {
      if (prev.includes(frameIdx)) {
        return prev.filter((f) => f !== frameIdx);
      }
      return [...prev, frameIdx];
    });
  }, []);

  // Save animation
  const saveAnimation = useCallback(() => {
    if (!newAnimName.trim() || selectedFrames.length === 0) return;
    const anim: AnimationDef = {
      name: newAnimName.trim(),
      sheet: selectedSheet,
      frames: [...selectedFrames],
    };
    setAnimations((prev) => [...prev, anim]);
    setNewAnimName("");
    setSelectedFrames([]);
  }, [newAnimName, selectedSheet, selectedFrames]);

  // Play an animation
  const playAnimation = useCallback((anim: AnimationDef) => {
    setSelectedSheet(anim.sheet);
    setActiveAnimation(anim);
    setIsPlaying(true);
  }, []);

  const stopAnimation = useCallback(() => {
    setIsPlaying(false);
    setActiveAnimation(null);
  }, []);

  // Export all animations as JSON
  const exportAnimations = useCallback(() => {
    const data = {
      frameSize: { w: FRAME_W, h: FRAME_H },
      sheets: SPRITE_SHEETS.map((s) => ({ name: s.name, baselines: s.baselines })),
      animations: animations.filter((a) => !a.name.startsWith("All Frames")),
    };
    const json = JSON.stringify(data, null, 2);
    navigator.clipboard.writeText(json);
    alert("Copied to clipboard!");
  }, [animations]);

  // Get row for a frame index
  const getRow = (frameIdx: number) => Math.floor(frameIdx / COLS);

  // Get frame position in sprite sheet (pixel coords)
  const getFramePos = (frameIdx: number) => {
    const col = frameIdx % COLS;
    const row = getRow(frameIdx);
    return { x: col * FRAME_W, y: row * FRAME_H };
  };

  // Get the baseline shift for a frame — how much to shift the sprite
  // down so all shadows align at MAX_BASELINE
  const getBaselineShift = (frameIdx: number, sheet?: number) => {
    const s = sheet ?? selectedSheet;
    const row = getRow(frameIdx);
    const baseline = SPRITE_SHEETS[s].baselines[row];
    return MAX_BASELINE - baseline;
  };

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: "0 auto", color: "#e0e0e0" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>🐱 Bogart Sprite Editor</h1>
      <p style={{ color: "#888", marginBottom: 24 }}>
        Frame: {FRAME_W}×{FRAME_H}px | Baseline-aligned preview | Click frames to build animations
      </p>

      {/* ── Controls ──────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "center",
          marginBottom: 24,
          flexWrap: "wrap",
        }}
      >
        <label>
          <span style={{ fontSize: 12, color: "#888" }}>Sheet</span>
          <select
            value={selectedSheet}
            onChange={(e) => {
              setSelectedSheet(Number(e.target.value));
              stopAnimation();
            }}
            style={{
              display: "block",
              background: "#2a2a2a",
              color: "#e0e0e0",
              border: "1px solid #444",
              borderRadius: 4,
              padding: "4px 8px",
            }}
          >
            {SPRITE_SHEETS.map((s, i) => (
              <option key={s.name} value={i}>
                {s.name} — baselines: [{s.baselines.join(", ")}]
              </option>
            ))}
          </select>
        </label>

        <label>
          <span style={{ fontSize: 12, color: "#888" }}>FPS: {fps}</span>
          <input
            type="range"
            min={1}
            max={24}
            value={fps}
            onChange={(e) => setFps(Number(e.target.value))}
            style={{ display: "block", width: 120 }}
          />
        </label>

        <div>
          <label style={{ fontSize: 12, color: "#888" }}>Zoom: {zoom.toFixed(1)}x</label>
          <input
            type="range"
            min={0.3}
            max={2}
            step={0.1}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            style={{ display: "block", width: 120 }}
          />
        </div>

        <label
          style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 13 }}
        >
          <input
            type="checkbox"
            checked={showGrid}
            onChange={(e) => setShowGrid(e.target.checked)}
          />
          Grid
        </label>
      </div>

      {/* ── Main layout: Grid + Preview ───────────────── */}
      <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
        {/* Sprite Grid */}
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: "#aaa" }}>
            Sprite Grid — {SPRITE_SHEETS[selectedSheet].name}
            {selectedFrames.length > 0 && (
              <span style={{ color: "#4CAF50", marginLeft: 8 }}>
                ({selectedFrames.length} selected: [{selectedFrames.join(", ")}])
              </span>
            )}
          </h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${COLS}, ${displayW}px)`,
              gap: showGrid ? 2 : 0,
              background: showGrid ? "#e8dff0" : "transparent",
              padding: showGrid ? 2 : 0,
              borderRadius: 8,
            }}
          >
            {Array.from({ length: TOTAL_FRAMES }, (_, i) => {
              const pos = getFramePos(i);
              const isSelected = selectedFrames.includes(i);
              const isCurrentFrame = currentFrame === i && isPlaying;
              const selIdx = selectedFrames.indexOf(i);
              return (
                // Sprite grid is a fixed Array.from() — the frame number IS the
                // identity, never reordered or filtered, so the index is the
                // correct stable key here.
                // react-doctor-disable-next-line react-doctor/no-array-index-as-key
                <button
                  type="button"
                  key={`frame-${i}`}
                  onClick={() => toggleFrame(i)}
                  aria-label={`Frame ${i}`}
                  aria-pressed={isSelected}
                  style={{
                    width: displayW,
                    height: displayH,
                    backgroundImage: `url(${SPRITE_SHEETS[selectedSheet].src})`,
                    backgroundPosition: `-${pos.x * zoom}px -${pos.y * zoom}px`,
                    backgroundSize: `${(sheetDimensions?.w || 0) * zoom}px ${(sheetDimensions?.h || 0) * zoom}px`,
                    cursor: "pointer",
                    position: "relative",
                    outline: isCurrentFrame
                      ? "3px solid #FFD700"
                      : isSelected
                        ? "3px solid #4CAF50"
                        : "none",
                    outlineOffset: -3,
                    borderRadius: 4,
                    overflow: "hidden",
                    padding: 0,
                    border: "none",
                  }}
                >
                  {/* Frame number badge */}
                  <span
                    style={{
                      position: "absolute",
                      top: 2,
                      left: 4,
                      fontSize: 11,
                      fontWeight: 700,
                      color: "#fff",
                      textShadow: "0 0 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.9)",
                      pointerEvents: "none",
                    }}
                  >
                    {i}
                  </span>
                  {/* Selection order badge */}
                  {isSelected && (
                    <span
                      style={{
                        position: "absolute",
                        top: 2,
                        right: 4,
                        fontSize: 11,
                        fontWeight: 700,
                        background: "#4CAF50",
                        color: "#fff",
                        borderRadius: "50%",
                        width: 18,
                        height: 18,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        pointerEvents: "none",
                      }}
                    >
                      {selIdx + 1}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Preview + Animation Controls */}
        <div style={{ minWidth: 280 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: "#aaa" }}>
            Preview (baseline-aligned)
          </h3>

          {/* Preview window — aligns frames on shadow baseline */}
          <div
            style={{
              width: displayW + 40,
              height: displayH + 40,
              background: "#e8dff0",
              borderRadius: 8,
              border: "1px solid #333",
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
              marginBottom: 16,
              overflow: "hidden",
              position: "relative",
            }}
          >
            {sheetDimensions && (
              <div
                style={{
                  width: displayW,
                  height: displayH,
                  position: "relative",
                  bottom: 20,
                  marginTop: getBaselineShift(currentFrame, activeAnimation?.sheet) * zoom,
                  backgroundImage: `url(${SPRITE_SHEETS[activeAnimation?.sheet ?? selectedSheet].src})`,
                  backgroundPosition: `-${getFramePos(currentFrame).x * zoom}px -${getFramePos(currentFrame).y * zoom}px`,
                  backgroundSize: `${sheetDimensions.w * zoom}px ${sheetDimensions.h * zoom}px`,
                  imageRendering: "pixelated",
                }}
              />
            )}
          </div>

          <div style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
            Frame: {currentFrame} (row {getRow(currentFrame)}) | Baseline:{" "}
            {SPRITE_SHEETS[activeAnimation?.sheet ?? selectedSheet].baselines[getRow(currentFrame)]}
            px | Shift: +{getBaselineShift(currentFrame, activeAnimation?.sheet)}px |{" "}
            {isPlaying ? `${fps} FPS` : "Stopped"}
            {activeAnimation && <span> | {activeAnimation.name}</span>}
          </div>

          {/* Playback controls */}
          <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
            <button
              onClick={() => {
                if (selectedFrames.length > 0) {
                  playAnimation({
                    name: "Selection",
                    sheet: selectedSheet,
                    frames: selectedFrames,
                  });
                }
              }}
              disabled={selectedFrames.length === 0}
              style={btnStyle}
            >
              ▶ Play Selection
            </button>
            <button onClick={stopAnimation} disabled={!isPlaying} style={btnStyle}>
              ⏹ Stop
            </button>
            <button
              onClick={() => setSelectedFrames([])}
              disabled={selectedFrames.length === 0}
              style={btnStyle}
            >
              ✕ Clear
            </button>
          </div>

          {/* Save animation */}
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: "#aaa" }}>
              Save Animation
            </h3>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                placeholder="Animation name..."
                value={newAnimName}
                onChange={(e) => setNewAnimName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveAnimation()}
                style={{
                  flex: 1,
                  background: "#2a2a2a",
                  color: "#e0e0e0",
                  border: "1px solid #444",
                  borderRadius: 4,
                  padding: "6px 10px",
                  fontSize: 13,
                }}
              />
              <button
                onClick={saveAnimation}
                disabled={!newAnimName.trim() || selectedFrames.length === 0}
                style={btnStyle}
              >
                💾 Save
              </button>
            </div>
            {selectedFrames.length > 0 && (
              <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                Frames: [{selectedFrames.join(", ")}] from {SPRITE_SHEETS[selectedSheet].name}
              </div>
            )}
          </div>

          {/* Saved animations list */}
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "#aaa" }}>Animations</h3>
              <button
                onClick={exportAnimations}
                style={{ ...btnStyle, fontSize: 11, padding: "2px 8px" }}
              >
                📋 Export JSON
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {animations.map((anim, i) => (
                <div
                  key={`${anim.sheet}:${anim.name}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={activeAnimation === anim}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 10px",
                    background: activeAnimation === anim ? "#2a3a2a" : "#222",
                    borderRadius: 4,
                    border: activeAnimation === anim ? "1px solid #4CAF50" : "1px solid #333",
                    cursor: "pointer",
                  }}
                  onClick={() => playAnimation(anim)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      playAnimation(anim);
                    }
                  }}
                >
                  <span style={{ flex: 1, fontSize: 13 }}>{anim.name}</span>
                  <span style={{ fontSize: 11, color: "#666" }}>
                    S{anim.sheet + 1} · {anim.frames.length}f
                  </span>
                  {!anim.name.startsWith("All Frames") && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setAnimations((prev) => prev.filter((_, j) => j !== i));
                        if (activeAnimation === anim) stopAnimation();
                      }}
                      style={{
                        background: "none",
                        border: "none",
                        color: "#666",
                        cursor: "pointer",
                        fontSize: 14,
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#333",
  color: "#e0e0e0",
  border: "1px solid #555",
  borderRadius: 4,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 13,
};
