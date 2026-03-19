export interface AudioPlaybackState {
  activeStreamIds: Set<string>;
}

export function createAudioPlaybackState(): AudioPlaybackState {
  return {
    activeStreamIds: new Set(),
  };
}

export function startVoiceStream(state: AudioPlaybackState, streamId: string): void {
  state.activeStreamIds.add(streamId);
}

export function endVoiceStream(state: AudioPlaybackState, streamId: string): boolean {
  if (!state.activeStreamIds.has(streamId)) {
    return state.activeStreamIds.size > 0;
  }

  state.activeStreamIds.delete(streamId);
  return state.activeStreamIds.size > 0;
}

export function shouldAcceptVoiceChunk(state: AudioPlaybackState, streamId: string): boolean {
  return state.activeStreamIds.has(streamId);
}

export function clearVoiceStreams(state: AudioPlaybackState): void {
  state.activeStreamIds.clear();
}
