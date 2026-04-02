/**
 * Bogart Sprite Editor
 *
 * Preview and define animation sequences from sprite sheets.
 * Each sprite sheet is 4 columns × 6 rows = 24 frames.
 * Frame 0 = top-left, Frame 23 = bottom-right.
 */

import { useState, useEffect, useCallback, useRef } from "react";

// ── Sprite sheet config ────────────────────────────────────
const COLS = 4;
const ROWS = 6;
const TOTAL_FRAMES = COLS * ROWS;

const SPRITE_SHEETS = [
  { name: "Sheet 1", src: "/bogart/sprites/sprite1.png" },
  { name: "Sheet 2", src: "/bogart/sprites/sprite2.png" },
  { name: "Sheet 3", src: "/bogart/sprites/sprite3.png" },
];

// ── Types ──────────────────────────────────────────────────
interface AnimationDef {
  name: string;
  sheet: number; // 0-based index into SPRITE_SHEETS
  frames: number[]; // frame indices (0-23)
  offsetX?: number; // px offset to adjust alignment
  offsetY?: number;
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
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [showGrid, setShowGrid] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load sheet dimensions
  useEffect(() => {
    const img = new Image();
    img.onload = () => setSheetDimensions({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = SPRITE_SHEETS[selectedSheet].src;
  }, [selectedSheet]);

  const frameW = sheetDimensions ? sheetDimensions.w / COLS : 0;
  const frameH = sheetDimensions ? sheetDimensions.h / ROWS : 0;

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
      offsetX,
      offsetY,
    };
    setAnimations((prev) => [...prev, anim]);
    setNewAnimName("");
    setSelectedFrames([]);
  }, [newAnimName, selectedSheet, selectedFrames, offsetX, offsetY]);

  // Play an animation
  const playAnimation = useCallback((anim: AnimationDef) => {
    setSelectedSheet(anim.sheet);
    setActiveAnimation(anim);
    setOffsetX(anim.offsetX || 0);
    setOffsetY(anim.offsetY || 0);
    setIsPlaying(true);
  }, []);

  const stopAnimation = useCallback(() => {
    setIsPlaying(false);
    setActiveAnimation(null);
  }, []);

  // Export all animations as JSON
  const exportAnimations = useCallback(() => {
    const json = JSON.stringify(
      animations.filter((a) => !a.name.startsWith("All Frames")),
      null,
      2,
    );
    navigator.clipboard.writeText(json);
    alert("Copied to clipboard!");
  }, [animations]);

  // Get frame position for CSS background-position
  const getFramePos = (frameIdx: number) => {
    const col = frameIdx % COLS;
    const row = Math.floor(frameIdx / COLS);
    return { x: col * frameW, y: row * frameH };
  };

  const displayW = frameW * zoom;
  const displayH = frameH * zoom;

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto", color: "#e0e0e0" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>🐱 Bogart Sprite Editor</h1>
      <p style={{ color: "#888", marginBottom: 24 }}>
        Define animation sequences from sprite sheets. Click frames to select, then save as named
        animations.
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
        <div>
          <label style={{ fontSize: 12, color: "#888" }}>Sheet</label>
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
              <option key={i} value={i}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ fontSize: 12, color: "#888" }}>FPS: {fps}</label>
          <input
            type="range"
            min={1}
            max={24}
            value={fps}
            onChange={(e) => setFps(Number(e.target.value))}
            style={{ display: "block", width: 120 }}
          />
        </div>

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

        <div>
          <label style={{ fontSize: 12, color: "#888" }}>Offset X: {offsetX}px</label>
          <input
            type="range"
            min={-50}
            max={50}
            value={offsetX}
            onChange={(e) => setOffsetX(Number(e.target.value))}
            style={{ display: "block", width: 120 }}
          />
        </div>

        <div>
          <label style={{ fontSize: 12, color: "#888" }}>Offset Y: {offsetY}px</label>
          <input
            type="range"
            min={-50}
            max={50}
            value={offsetY}
            onChange={(e) => setOffsetY(Number(e.target.value))}
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
              background: showGrid ? "#333" : "transparent",
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
                <div
                  key={i}
                  onClick={() => toggleFrame(i)}
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
                </div>
              );
            })}
          </div>
        </div>

        {/* Preview + Animation Controls */}
        <div style={{ minWidth: 280 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: "#aaa" }}>Preview</h3>

          {/* Preview window */}
          <div
            style={{
              width: displayW + 40,
              height: displayH + 40,
              background: "#1a1a1a",
              borderRadius: 8,
              border: "1px solid #333",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 16,
              overflow: "hidden",
            }}
          >
            {sheetDimensions && (
              <div
                style={{
                  width: displayW,
                  height: displayH,
                  backgroundImage: `url(${SPRITE_SHEETS[selectedSheet].src})`,
                  backgroundPosition: `-${getFramePos(currentFrame).x * zoom + offsetX}px -${getFramePos(currentFrame).y * zoom + offsetY}px`,
                  backgroundSize: `${sheetDimensions.w * zoom}px ${sheetDimensions.h * zoom}px`,
                  imageRendering: "pixelated",
                }}
              />
            )}
          </div>

          <div style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
            Frame: {currentFrame} | {isPlaying ? `Playing @ ${fps} FPS` : "Stopped"}
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
                    offsetX,
                    offsetY,
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
                {(offsetX !== 0 || offsetY !== 0) && ` | offset: (${offsetX}, ${offsetY})`}
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
                  key={i}
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
