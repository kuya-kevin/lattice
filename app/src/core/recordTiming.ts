// Where a take lands on the timeline (pure, unit-tested). Times are on the AudioContext clock
// ("ctx time": when a sample leaves Web Audio). The player hears it `outputDelay` later and
// the mic hands what they play back `inputDelay` after that, so both are compensated here,
// the way GarageBand's recording delay / playhead latency compensation do.
import type { PlayedNote } from './musicalTyping';

/** Timeline `pos` leaves Web Audio at ctx time `ctxTime` (the transport, or a count-in's downbeat). */
export interface TransportAnchor {
  ctxTime: number;
  pos: number;
}

/** The timeline position the player is hearing at ctx time `ctxNow` (MIDI note times). */
export const heardPosition = (ctxNow: number, a: TransportAnchor, outputDelay: number) => a.pos + (ctxNow - outputDelay - a.ctxTime);

/** The ctx time at which timeline `pos` leaves Web Audio. */
export const ctxTimeAt = (pos: number, a: TransportAnchor) => a.ctxTime + (pos - a.pos);

/** How much to cut from the front of a mic take whose first sample was captured at ctx time
 *  `recStart`, so it lines up with the anchor's position as the player heard it. A recorder
 *  that started too late can't be trimmed; its take moves later instead. */
export function trimTake(o: { anchor: TransportAnchor; recStart: number; outputDelay: number; inputDelay: number }): { trim: number; start: number } {
  const trim = o.anchor.ctxTime + o.outputDelay + o.inputDelay - o.recStart;
  return trim >= 0 ? { trim, start: o.anchor.pos } : { trim: 0, start: o.anchor.pos - trim };
}

/** The transport's cycle: on reaching `end` it jumps back to `start`. It only loops when it
 *  started before `end` (Logic, waveform-playlist), so pass null otherwise. */
export interface Cycle {
  start: number;
  end: number;
}

/** Where linear take position `p` (counted on past each wrap) is on the timeline. */
export function onCycle(p: number, c: Cycle | null): number {
  if (!c || p < c.end) return p;
  return c.start + ((p - c.end) % (c.end - c.start));
}

/** Linear position where pass `k` begins (pass 0 is the take's start, up to the first wrap). */
const passStart = (k: number, takeStart: number, c: Cycle) => (k === 0 ? takeStart : c.end + (k - 1) * (c.end - c.start));
const passOf = (p: number, c: Cycle) => (p < c.end ? 0 : 1 + Math.floor((p - c.end) / (c.end - c.start)));

/** A MIDI take recorded over cycle passes, merged into one region as GarageBand does: once it
 *  wraps, the region spans the cycle (plus any lead-in before it) and every note lands where it
 *  was heard. A note held across a wrap is cut at the cycle end. */
export function foldMidiTake(played: PlayedNote[], start: number, stop: number, c: Cycle | null): { start: number; end: number; played: PlayedNote[] } {
  if (!c || stop < c.end) return { start, end: stop, played };
  const folded = played.map((n) => {
    const nextWrap = passStart(passOf(n.start, c) + 1, start, c);
    const end = Math.min(n.end ?? stop, stop, nextWrap);
    const s = onCycle(n.start, c);
    return { ...n, start: s, end: s + (end - n.start) };
  });
  return { start: Math.min(start, c.start), end: c.end, played: folded };
}

/** The part of a mic take to keep after cycle recording: the latest pass, as GarageBand shows
 *  the latest take, unless it is shorter than `minPass` (stopping just after a wrap), then the
 *  pass before. `offset` is from the take's start (linear), `start` is on the timeline. */
export function cycleMicTake(start: number, stop: number, c: Cycle | null, minPass: number): { offset: number; start: number; duration: number } {
  if (!c || stop < c.end) return { offset: 0, start, duration: stop - start };
  let k = passOf(stop, c);
  if (stop - passStart(k, start, c) < minPass) k -= 1;
  const from = passStart(k, start, c);
  const to = Math.min(stop, passStart(k + 1, start, c));
  return { offset: from - start, start: k === 0 ? start : c.start, duration: to - from };
}
