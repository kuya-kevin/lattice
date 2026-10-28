// Tap tempo (Logic's Tap Tempo key command, T): each tap adds a time; after two taps the tempo
// is the average of the last few intervals. A pause of 2 s starts a new count.
import { TEMPO_RANGE } from './session';

export interface TapState {
  taps: number[]; // ms timestamps, oldest first
  bpm: number | null;
}

export const TAP_RESET_MS = 2000; // also when a tap run ends and the tempo is committed
const KEEP = 5; // taps averaged (4 intervals)

export function tapTempo(prev: TapState | undefined, now: number): TapState {
  const last = prev?.taps[prev.taps.length - 1];
  const taps = last != null && now - last < TAP_RESET_MS ? [...prev!.taps, now].slice(-KEEP) : [now];
  if (taps.length < 2) return { taps, bpm: null };
  const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
  const bpm = Math.min(TEMPO_RANGE[1], Math.max(TEMPO_RANGE[0], Math.round(60000 / avg)));
  return { taps, bpm };
}
