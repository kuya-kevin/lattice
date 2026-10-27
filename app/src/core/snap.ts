// Snap-to-grid math for clip moves, trims and library drops (pure, unit-tested).
// Logic's "Snap" menu offers Bar / Beat / Division / ...; GarageBand has one Snap to Grid
// toggle. We offer Off / Bar / Beat, on the session's tempo and time signature.
import { barLength, beatLength, type Meter } from './metronome';

export type SnapMode = 'off' | 'bar' | 'beat';
export const SNAP_MODES: SnapMode[] = ['off', 'bar', 'beat'];

/** Grid step in seconds, or 0 when snapping is off. */
export function gridSeconds(mode: SnapMode, m: Meter): number {
  if (mode === 'bar') return barLength(m);
  if (mode === 'beat') return beatLength(m);
  return 0;
}

/** Nearest grid line to `t` (never before 0). With snapping off, just clamps and rounds to ms. */
export function snapTime(t: number, mode: SnapMode, m: Meter): number {
  const g = gridSeconds(mode, m);
  const x = Math.max(0, t);
  const snapped = g > 0 ? Math.round(x / g) * g : x;
  return Math.round(snapped * 1000) / 1000;
}

/** New clip start after dragging it by `delta` seconds: the clip's start lands on the grid
 *  (like Logic, the region's left edge snaps, not the pointer). */
export function snapMove(start: number, delta: number, mode: SnapMode, m: Meter): number {
  return snapTime(start + delta, mode, m);
}

/** Pixel x inside the timeline -> seconds. */
export const pxToSeconds = (px: number, samplesPerPixel: number, sampleRate: number) => (px * samplesPerPixel) / sampleRate;
export const secondsToPx = (s: number, samplesPerPixel: number, sampleRate: number) => (s * sampleRate) / samplesPerPixel;
