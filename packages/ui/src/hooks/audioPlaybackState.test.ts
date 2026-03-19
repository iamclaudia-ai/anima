import { describe, expect, it } from "bun:test";
import {
  clearVoiceStreams,
  createAudioPlaybackState,
  endVoiceStream,
  shouldAcceptVoiceChunk,
  startVoiceStream,
} from "./audioPlaybackState";

describe("audioPlaybackState", () => {
  it("keeps overlapping voice streams active until each one ends", () => {
    const state = createAudioPlaybackState();

    startVoiceStream(state, "stream-a");
    startVoiceStream(state, "stream-b");

    expect(shouldAcceptVoiceChunk(state, "stream-a")).toBe(true);
    expect(shouldAcceptVoiceChunk(state, "stream-b")).toBe(true);

    expect(endVoiceStream(state, "stream-b")).toBe(true);
    expect(shouldAcceptVoiceChunk(state, "stream-a")).toBe(true);
    expect(shouldAcceptVoiceChunk(state, "stream-b")).toBe(false);

    expect(endVoiceStream(state, "stream-a")).toBe(false);
    expect(shouldAcceptVoiceChunk(state, "stream-a")).toBe(false);
  });

  it("ignores unknown stream ends and clears all streams on stop", () => {
    const state = createAudioPlaybackState();

    startVoiceStream(state, "stream-a");

    expect(endVoiceStream(state, "missing-stream")).toBe(true);
    expect(shouldAcceptVoiceChunk(state, "stream-a")).toBe(true);

    clearVoiceStreams(state);
    expect(shouldAcceptVoiceChunk(state, "stream-a")).toBe(false);
  });
});
