/**
 * Live audio playback tuning panel.
 *
 * TEMPORARY — used to dial in lookahead / fade / silence parameters
 * without rebuilds. Includes a "Speak" button that triggers voice.speak
 * with custom test text so we don't have to prompt Claudia each round.
 */

import { useEffect, useRef, useState } from "react";
import {
  type AudioConfig,
  getAudioConfig,
  getAudioConfigDefaults,
  resetAudioConfig,
  setAudioConfig,
  subscribeAudioConfig,
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
  const [text, setText] = useState(DEFAULT_TEST_TEXT);
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    return subscribeAudioConfig(() => {
      setCfgState({ ...getAudioConfig() });
    });
  }, []);

  const update = (patch: Partial<AudioConfig>) => {
    setAudioConfig(patch);
  };

  const reset = () => {
    resetAudioConfig();
  };

  const speak = () => {
    if (!textRef.current.trim()) return;
    gateway.sendRequest("voice.speak", { text: textRef.current });
  };

  const stop = () => {
    gateway.sendRequest("voice.stop");
  };

  const defaults = getAudioConfigDefaults();

  return (
    <div className="absolute right-4 bottom-24 z-50 w-80 rounded-xl border border-purple-300/40 bg-white/95 p-4 shadow-xl backdrop-blur dark:border-purple-400/30 dark:bg-slate-900/95">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-purple-700 dark:text-purple-300">Audio Debug</h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-200"
        >
          close
        </button>
      </div>

      <Slider
        label="Lookahead"
        unit="ms"
        min={0}
        max={400}
        step={5}
        value={cfg.lookaheadMs}
        defaultValue={defaults.lookaheadMs}
        onChange={(v) => update({ lookaheadMs: v })}
      />
      <Slider
        label="Stream-start buffer"
        unit="ms"
        min={0}
        max={500}
        step={5}
        value={cfg.streamStartBufferMs}
        defaultValue={defaults.streamStartBufferMs}
        onChange={(v) => update({ streamStartBufferMs: v })}
      />
      <Slider
        label="Fade samples"
        unit="smp"
        min={0}
        max={1024}
        step={8}
        value={cfg.fadeSamples}
        defaultValue={defaults.fadeSamples}
        onChange={(v) => update({ fadeSamples: v })}
      />
      <div className="mt-2 mb-3 flex items-center justify-between text-xs">
        <label className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={cfg.fadeEnabled}
            onChange={(e) => update({ fadeEnabled: e.target.checked })}
          />
          Fade enabled
        </label>
        <button
          type="button"
          onClick={reset}
          className="text-purple-600 hover:underline dark:text-purple-300"
        >
          reset all
        </button>
      </div>
      <Slider
        label="Inter-chunk silence"
        unit="ms"
        min={0}
        max={100}
        step={1}
        value={cfg.interChunkSilenceMs}
        defaultValue={defaults.interChunkSilenceMs}
        onChange={(v) => update({ interChunkSilenceMs: v })}
      />

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
