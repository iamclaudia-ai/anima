/**
 * Live audio playback tuning panel.
 *
 * TEMPORARY — used to dial in worklet ring-buffer parameters without
 * rebuilds. Includes a live buffer level meter, an underrun counter,
 * and a "Speak" button that triggers voice.speak with custom test text.
 */

import { useEffect, useRef, useState } from "react";
import {
  type AudioConfig,
  type AudioStatus,
  getAudioConfig,
  getAudioConfigDefaults,
  getAudioStatus,
  resetAudioConfig,
  setAudioConfig,
  subscribeAudioConfig,
  subscribeAudioStatus,
} from "../hooks/audioConfig";
import type { UseChatGatewayReturn } from "../hooks/useChatGateway";

interface AudioDebugPanelProps {
  gateway: UseChatGatewayReturn;
  onClose(): void;
}

const DEFAULT_TEST_TEXT =
  "Hi sweetheart, this is a longer test of voice playback so you can hear how the audio sounds across many words and a couple of sentences in a row. Listen for clicks, pops, or any choppy texture as I keep talking. The longer this runs, the easier it should be to spot any issues sneaking in.";

export function AudioDebugPanel({ gateway, onClose }: AudioDebugPanelProps) {
  const [cfg, setCfgState] = useState<AudioConfig>(() => ({ ...getAudioConfig() }));
  const [status, setStatusState] = useState<AudioStatus>(() => ({ ...getAudioStatus() }));
  const [text, setText] = useState(DEFAULT_TEST_TEXT);
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => subscribeAudioConfig(() => setCfgState({ ...getAudioConfig() })), []);
  useEffect(() => subscribeAudioStatus(() => setStatusState({ ...getAudioStatus() })), []);

  const update = (patch: Partial<AudioConfig>) => setAudioConfig(patch);
  const reset = () => resetAudioConfig();
  const speak = () => {
    if (!textRef.current.trim()) return;
    gateway.sendRequest("voice.speak", { text: textRef.current });
  };
  const stop = () => gateway.sendRequest("voice.stop");

  const defaults = getAudioConfigDefaults();

  // Buffer level bar — fill ms relative to ring capacity.
  const fillPct = Math.min(100, Math.round((status.fillMs / Math.max(1, cfg.ringBufferMs)) * 100));
  const fillBar = (
    <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-slate-700 dark:text-slate-300">Buffer level</span>
        <span className="font-mono text-slate-500 dark:text-slate-400">
          {status.fillMs}ms / {cfg.ringBufferMs}ms
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
        <div
          className={`h-full transition-all duration-75 ${
            status.fillMs === 0
              ? "bg-red-500"
              : status.fillMs < cfg.primerBufferMs
                ? "bg-amber-400"
                : "bg-emerald-500"
          }`}
          style={{ width: `${fillPct}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400">
        <span>primer at {cfg.primerBufferMs}ms</span>
        <span className={status.underruns > 0 ? "font-semibold text-red-500" : ""}>
          underruns: {status.underruns}
        </span>
      </div>
    </div>
  );

  return (
    <div className="absolute right-4 bottom-24 z-50 w-80 rounded-xl border border-purple-300/40 bg-white/95 p-4 shadow-xl backdrop-blur dark:border-purple-400/30 dark:bg-slate-900/95">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-purple-700 dark:text-purple-300">
          Audio Debug — Worklet
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-200"
        >
          close
        </button>
      </div>

      <Slider
        label="Primer buffer"
        unit="ms"
        min={0}
        max={500}
        step={5}
        value={cfg.primerBufferMs}
        defaultValue={defaults.primerBufferMs}
        onChange={(v) => update({ primerBufferMs: v })}
      />
      <Slider
        label="Ring buffer (capacity)"
        unit="ms"
        min={500}
        max={8000}
        step={100}
        value={cfg.ringBufferMs}
        defaultValue={defaults.ringBufferMs}
        onChange={(v) => update({ ringBufferMs: v })}
      />

      <div className="mt-2 flex items-center justify-end text-xs">
        <button
          type="button"
          onClick={reset}
          className="text-purple-600 hover:underline dark:text-purple-300"
        >
          reset all
        </button>
      </div>

      {fillBar}

      <p className="mt-2 text-[10px] leading-tight text-slate-500 dark:text-slate-400">
        Ring capacity changes apply on next reload (worklet node is rebuilt). Primer applies live.
      </p>

      <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-700">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          className="w-full resize-none rounded border border-slate-300 bg-white p-2 text-xs text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        />
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={speak}
            className="flex-1 rounded bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700"
          >
            Speak
          </button>
          <button
            type="button"
            onClick={stop}
            className="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}

interface SliderProps {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  defaultValue: number;
  onChange(v: number): void;
}

function Slider({ label, unit, min, max, step, value, defaultValue, onChange }: SliderProps) {
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-slate-700 dark:text-slate-300">{label}</span>
        <span className="font-mono text-slate-500 dark:text-slate-400">
          {value}
          {unit}
          {value !== defaultValue && (
            <span className="ml-1 text-slate-400 dark:text-slate-500">(def {defaultValue})</span>
          )}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-purple-600"
      />
    </div>
  );
}
