// The take being recorded, as the arrange shows it while it grows (Logic, GarageBand): the
// recorder (ControlBar) sets it, the arrange reads it. A mic take carries the waveform-playlist
// `recordingState` (live peaks); a MIDI take carries the notes played so far, region-relative.
import { useSyncExternalStore } from 'react';
import type { MidiNote } from '../core/midi';

export interface AudioPreview {
  isRecording: true;
  trackId: string;
  startSample: number;
  durationSamples: number;
  peaks: (Int8Array | Int16Array)[];
  bits: 8 | 16;
  /** seconds of the capture before the take's first heard sample (count-in, latency) */
  latencyOffset: number;
}

export type LiveTake =
  | { kind: 'audio'; trackId: string; preview: AudioPreview | null }
  | { kind: 'midi'; trackId: string; start: number; duration: number; notes: MidiNote[] };

let current: LiveTake | null = null;
const listeners = new Set<() => void>();

export const liveTake = {
  get: () => current,
  set(t: LiveTake | null) {
    current = t;
    for (const l of listeners) l();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

export const useLiveTake = () => useSyncExternalStore(liveTake.subscribe, liveTake.get);
