// Snap-to-grid math for clip moves, trims and library drops (pure, unit-tested).
// Logic's "Snap" menu offers Bar / Beat / Division / ...; GarageBand has one Snap to Grid
// toggle. We offer Off / Bar / Beat / 1/16 (Logic's "Division" at its 1/16 default), on the
// session's tempo and time signature.
import { barLength, beatLength, type Meter } from './metronome';

export type SnapMode = 'off' | 'bar' | 'beat' | 'sixteenth';
export const SNAP_MODES: SnapMode[] = ['off', 'bar', 'beat', 'sixteenth'];
export const SNAP_LABELS: Record<SnapMode, string> = { off: 'Off', bar: 'Bar', beat: 'Beat', sixteenth: '1/16' };

/** Grid step in seconds, or 0 when snapping is off. A 1/16 is a quarter of a quarter note
 *  whatever the time signature (in 6/8 that is half an eighth-note beat). */
export function gridSeconds(mode: SnapMode, m: Meter): number {
  if (mode === 'bar') return barLength(m);
  if (mode === 'beat') return beatLength(m);
  if (mode === 'sixteenth') return 60 / m.tempo / 4;
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

/** The cycle area around the selected clips: [start, end] widened out to the snap grid (the
 *  grid line at or before the first clip, the one at or after the last clip's end), so with
 *  Snap: Beat clips from 1.4 to just before 2.4 cycle 1.4-2.4. Snap off: the clips' own edges.
 *  An edge already on a grid line stays put. */
export function cycleAround(start: number, end: number, mode: SnapMode, m: Meter): { start: number; end: number } {
  const g = gridSeconds(mode, m);
  const a = g ? Math.floor(start / g + 1e-6) * g : start;
  const b = g ? Math.max(a + g, Math.ceil(end / g - 1e-6) * g) : end;
  return { start: Math.round(a * 1000) / 1000, end: Math.round(b * 1000) / 1000 };
}

/** A cycle area dragged in the ruler, on the grid. A drag never collapses it to nothing: an
 *  area that would be shorter than one grid step gets one step. Null when nothing changes. */
export function snapCycle(start: number, end: number, mode: SnapMode, m: Meter): { start: number; end: number } | null {
  const g = gridSeconds(mode, m);
  if (!g || !(end > start)) return null;
  const a = snapTime(start, mode, m);
  let b = snapTime(end, mode, m);
  if (b <= a) b = Math.round((a + g) * 1000) / 1000;
  return Math.abs(a - start) < 1e-4 && Math.abs(b - end) < 1e-4 ? null : { start: a, end: b };
}
