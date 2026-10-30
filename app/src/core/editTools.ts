// B16 "Muse acts on clear instructions": the arrange, mix, track and edit tools that were
// missing for concrete requests ("split it at bar 9", "delete bars 5-8", "pan the double 30%
// left", "duplicate the vocal track", "make the drums blue", "fade the vocal out over 2 s").
// Positions are 1-based bars where that is how people say them; "bars 5-8" is inclusive, as
// spoken. Pure session ops live here too, so session.ts only grows by small additions.
import * as S from './session';
import * as C from '../fx/chain';
import { colorName, colorSlot, TRACK_COLOR_NAMES } from './trackColors';
import { barLength } from './metronome';
import type { ToolContext, ToolDef } from './tools';

const num = (description: string, extra: object = {}) => ({ type: 'number', description, ...extra });
const str = (description: string, extra: object = {}) => ({ type: 'string', description, ...extra });
const bool = (description: string) => ({ type: 'boolean', description });
const ids = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const EPS = 0.005;

// ─── pure ops ───

/** The part of a clip that plays inside [a, b) on the timeline (same id), or null. Edge fades
 *  stay only on edges that are still the clip's own. */
export function clipPart(c: S.Clip, a: number, b: number): S.Clip | null {
  const end = c.start + c.duration;
  const from = Math.max(a, c.start);
  const to = Math.min(b, end);
  if (!(to - from > 0.01)) return null;
  const part: S.Clip = { ...c, start: r3(from), offset: r3(c.offset + from - c.start), duration: r3(to - from) };
  if (from > c.start + EPS) delete part.fadeIn;
  if (to < end - EPS) delete part.fadeOut;
  return part;
}

/** Keep the selection to clips that still exist. */
function fixSelection(s: S.Session): S.Session {
  const all = new Set(s.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  const sel = s.selection;
  const multi = sel.clipIds?.filter((id) => all.has(id));
  const clipId = sel.clipId && all.has(sel.clipId) ? sel.clipId : null;
  if (multi && multi.length > 1) return { ...s, selection: { trackId: sel.trackId, clipId: clipId ?? multi[multi.length - 1], clipIds: multi } };
  return { ...s, selection: { trackId: sel.trackId, clipId: clipId ?? multi?.[0] ?? null } };
}

/** Split clips at timeline second `t`: the left part keeps the id, the right part gets a new one.
 *  Clips that don't cross `t` are refused. */
export function splitClips(s: S.Session, clipIds: string[], t: number): { session: S.Session; parts: [string, string][] } {
  let out = s;
  const parts: [string, string][] = [];
  for (const id of clipIds) {
    const { track, clip } = S.findClip(out, id);
    const left = clipPart(clip, -Infinity, t);
    const right = clipPart(clip, t, Infinity);
    if (!left || !right) throw new S.SessionError(`clip ${id} (${r3(clip.start)}-${r3(clip.start + clip.duration)}s) does not cross ${r3(t)}s`);
    const [s1, rid] = S.nextId(out, 'c');
    out = S.mapTrack(s1, track.id, (tr) => ({ ...tr, clips: tr.clips.flatMap((c) => (c.id === id ? [left, { ...right, id: rid }] : [c])) }));
    parts.push([id, rid]);
  }
  return { session: out, parts };
}

/** Remove [a, b) from tracks (default all): clips inside go, clips across the edges are cut.
 *  With `closeGap`, everything after b moves earlier by b - a (Logic's "delete section"). */
export function deleteRange(s: S.Session, a: number, b: number, opts: { trackIds?: string[]; closeGap?: boolean } = {}): { session: S.Session; removed: string[]; cut: string[] } {
  if (!(b > a)) throw new S.SessionError('the range is empty');
  const scope = new Set(opts.trackIds ?? s.tracks.map((t) => t.id));
  for (const id of scope) S.getTrack(s, id);
  const shift = opts.closeGap ?? true ? b - a : 0;
  let out = s;
  const removed: string[] = [];
  const cut: string[] = [];
  for (const t of s.tracks) {
    if (!scope.has(t.id)) continue;
    const clips: S.Clip[] = [];
    for (const c of t.clips) {
      const end = c.start + c.duration;
      if (end <= a + EPS) { clips.push(c); continue; }
      if (c.start >= b - EPS) { clips.push(shift ? { ...c, start: r3(c.start - shift) } : c); continue; }
      const before = clipPart(c, -Infinity, a);
      const after = clipPart(c, b, Infinity);
      if (!before && !after) { removed.push(c.id); continue; }
      cut.push(c.id);
      if (before) clips.push(before);
      if (after) {
        let id = c.id;
        if (before) [out, id] = S.nextId(out, 'c');
        clips.push({ ...after, id, start: r3(after.start - shift) });
      }
    }
    out = S.mapTrack(out, t.id, (tr) => ({ ...tr, clips }));
  }
  return { session: fixSelection(out), removed, cut };
}

/** Make room: everything at or after `a` moves later by `len` s; clips across `a` are split. */
export function insertTime(s: S.Session, a: number, len: number, trackIds?: string[]): S.Session {
  if (!(len > 0)) throw new S.SessionError('insert at least some time');
  const scope = new Set(trackIds ?? s.tracks.map((t) => t.id));
  let out = s;
  for (const t of s.tracks) {
    if (!scope.has(t.id)) continue;
    const clips: S.Clip[] = [];
    for (const c of t.clips) {
      if (c.start + c.duration <= a + EPS) { clips.push(c); continue; }
      if (c.start >= a - EPS) { clips.push({ ...c, start: r3(c.start + len) }); continue; }
      const [s1, id] = S.nextId(out, 'c');
      out = s1;
      clips.push(clipPart(c, -Infinity, a)!, { ...clipPart(c, a, Infinity)!, id, start: r3(a + len) });
    }
    out = S.mapTrack(out, t.id, (tr) => ({ ...tr, clips }));
  }
  return out;
}

/** Copy what plays in [a, b) on tracks (default all) to start at `to`, as new clips layered over
 *  whatever is there. */
export function copyRange(s: S.Session, a: number, b: number, to: number, trackIds?: string[]): { session: S.Session; clips: string[] } {
  if (!(b > a)) throw new S.SessionError('the range is empty');
  const scope = new Set(trackIds ?? s.tracks.map((t) => t.id));
  let out = s;
  const made: string[] = [];
  for (const t of s.tracks) {
    if (!scope.has(t.id)) continue;
    const copies: S.Clip[] = [];
    for (const c of t.clips) {
      const part = clipPart(c, a, b);
      if (!part) continue;
      const [s1, id] = S.nextId(out, 'c');
      out = s1;
      copies.push({ ...part, id, start: r3(Math.max(0, part.start - a + to)) });
      made.push(id);
    }
    if (copies.length) out = S.mapTrack(out, t.id, (tr) => ({ ...tr, clips: [...tr.clips, ...copies] }));
  }
  if (!made.length) throw new S.SessionError('nothing plays in that range');
  return { session: out, clips: made };
}

/** Repeat a clip: `times` copies, each `every` s after the last (default: the clip's length, so
 *  they butt together), optionally stopping at `until` s (the last copy is cut there). */
export function repeatClip(s: S.Session, clipId: string, times: number, every?: number, until?: number): { session: S.Session; clips: string[] } {
  const { track, clip } = S.findClip(s, clipId);
  const step = every ?? clip.duration;
  if (!(step > 0.01)) throw new S.SessionError('the repeat spacing must be > 0');
  let out = s;
  const copies: S.Clip[] = [];
  for (let k = 1; k <= times; k++) {
    const start = clip.start + k * step;
    if (until !== undefined && start >= until - EPS) break;
    const [s1, id] = S.nextId(out, 'c');
    out = s1;
    const copy = { ...clip, id, start: r3(start) };
    copies.push(until !== undefined ? clipPart(copy, -Infinity, until) ?? copy : copy);
  }
  if (!copies.length) throw new S.SessionError('no room for a copy before the end bar');
  return { session: S.mapTrack(out, track.id, (t) => ({ ...t, clips: [...t.clips, ...copies] })), clips: copies.map((c) => c.id) };
}

/** Copy a track right below itself: clips (new ids), devices (new ids), gain, mute, colour slot
 *  of its own. Not armed or soloed. */
export function duplicateTrack(s: S.Session, trackId: string, withClips = true): [S.Session, S.Track] {
  const src = S.getTrack(s, trackId);
  const [s1, copy] = S.addTrack(s, `${src.name} copy`);
  let out = s1;
  const clips: S.Clip[] = [];
  if (withClips) for (const c of src.clips) {
    const [s2, id] = S.nextId(out, 'c');
    out = s2;
    clips.push({ ...c, id });
  }
  const devices: S.DeviceInstance[] = [];
  for (const d of src.devices) {
    const [s3, id] = S.nextId(out, 'd');
    out = s3;
    devices.push({ ...d, id, params: { ...d.params } });
  }
  const t: S.Track = { ...copy, gainDb: src.gainDb, muted: src.muted, clips, devices, ...(src.heightScale ? { heightScale: src.heightScale } : {}) };
  const rest = out.tracks.filter((x) => x.id !== copy.id);
  const at = rest.findIndex((x) => x.id === trackId) + 1;
  // pin colours first so the tracks below keep theirs when the copy is inserted (moveTrack does the same)
  const pinned = rest.map((x, i) => (x.color === undefined ? { ...x, color: i } : x));
  return [{ ...out, tracks: [...pinned.slice(0, at), t, ...pinned.slice(at)] }, t];
}

export function setTrackColor(s: S.Session, trackId: string, name: string): S.Session {
  const slot = colorSlot(name);
  if (slot < 0) throw new S.SessionError(`no colour "${name}" (colours: ${TRACK_COLOR_NAMES.join(', ')})`);
  return S.mapTrack(s, trackId, (t) => ({ ...t, color: slot }));
}

/** Set a clip's fade-in and/or fade-out (s; 0 removes it). A fade is at most the clip's length. */
export function setFades(s: S.Session, clipId: string, fadeIn?: number, fadeOut?: number): S.Session {
  const { track, clip } = S.findClip(s, clipId);
  const fit = (x: number) => {
    if (!(x >= 0)) throw new S.SessionError('a fade length must be >= 0 s');
    return r3(Math.min(x, clip.duration));
  };
  const next: S.Clip = { ...clip };
  if (fadeIn !== undefined) fit(fadeIn) ? (next.fadeIn = fit(fadeIn)) : delete next.fadeIn;
  if (fadeOut !== undefined) fit(fadeOut) ? (next.fadeOut = fit(fadeOut)) : delete next.fadeOut;
  return S.mapTrack(s, track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? next : c)) }));
}

/** Pan a track with a Utility device: the existing one (the first, if several), else a new one
 *  at the end of the chain. -1 = hard left, 1 = hard right. */
export function setPan(s: S.Session, trackId: string, pan: number): { session: S.Session; deviceId: string; inserted: boolean } {
  if (!(pan >= -1 && pan <= 1)) throw new S.SessionError('pan must be -1 (left) to 1 (right)');
  const t = S.getTrack(s, trackId);
  const have = t.devices.find((d) => d.kind === 'utility');
  let out = s;
  let id = have?.id;
  if (!id) {
    const [s1, dev] = C.insertDevice(s, trackId, 'utility');
    out = s1;
    id = dev.id;
  }
  const [s2] = C.setDeviceParam(out, trackId, id, 'pan', pan, { range: 'full' });
  return { session: s2, deviceId: id, inserted: !have };
}

/** A clip's fades in the playout engine's shape (renderer/audio.ts), at most the clip's length. */
export function playoutFades(c: S.Clip): { fadeIn?: { duration: number; type: 'linear' }; fadeOut?: { duration: number; type: 'linear' } } {
  return {
    ...(c.fadeIn ? { fadeIn: { duration: Math.min(c.fadeIn, c.duration), type: 'linear' as const } } : {}),
    ...(c.fadeOut ? { fadeOut: { duration: Math.min(c.fadeOut, c.duration), type: 'linear' as const } } : {}),
  };
}

// ─── argument helpers ───

/** Timeline seconds from a 1-based `bar` (decimals ok) or seconds; null when neither is given. */
export function timeArg(s: S.Session, bar: unknown, seconds: unknown): number | null {
  if (typeof bar === 'number') {
    if (!(bar >= 1)) throw new S.SessionError('bars start at 1');
    return S.barToSeconds(s, bar);
  }
  return typeof seconds === 'number' ? seconds : null;
}

/** [start, end) seconds of the inclusive bar range from_bar..to_bar ("bars 5-8"). */
export function barRange(s: S.Session, from: number, to: number): [number, number] {
  if (!(from >= 1) || !(to >= from)) throw new S.SessionError('give from_bar >= 1 and to_bar >= from_bar');
  return [S.barToSeconds(s, from), S.barToSeconds(s, to + 1)];
}

function targetClips(s: S.Session, a: { clip_id?: string; clip_ids?: string[] }): string[] {
  const list = a.clip_ids ?? (a.clip_id ? [a.clip_id] : S.selectedClipIds(s));
  if (!list.length) throw new S.SessionError('no clip given and no clip selected');
  for (const id of list) S.findClip(s, id);
  return list;
}

function edit(ctx: ToolContext, fn: (s: S.Session) => S.Session): S.Session {
  const next = fn(ctx.store.get());
  ctx.store.set(next);
  return next;
}

const bars = (s: S.Session, t: number) => S.barOf(s, t);

export const EDIT_TOOLS: ToolDef[] = [
  // ---- arrange ----
  {
    name: 'split_clip',
    description:
      'Split clips in two at a position (the "scissors"): at a bar (1-based, decimals ok, e.g. 9 or 9.5) or at seconds. ' +
      'Defaults to the selected clips; with track_id and no clip, every clip on that track that crosses the position. The left part keeps the id.',
    parameters: obj({
      bar: num('Split position in bars, e.g. 9 = where bar 9 starts'),
      at: num('Or: split position in timeline seconds'),
      clip_id: str('Clip id; omit for the selected clips'),
      track_id: str('Or: split every clip on this track that crosses the position'),
    }),
    run: (ctx, a) => {
      const s0 = ctx.store.get();
      const t = timeArg(s0, a.bar, a.at);
      if (t === null) throw new S.SessionError('give bar or at');
      const list = a.clip_id || !a.track_id
        ? targetClips(s0, a)
        : S.getTrack(s0, a.track_id).clips.filter((c) => c.start < t - 0.01 && c.start + c.duration > t + 0.01).map((c) => c.id);
      if (!list.length) throw new S.SessionError(`no clip on ${a.track_id} crosses bar ${bars(s0, t)}`);
      const r = splitClips(s0, list, t);
      ctx.store.set(r.session);
      return { at: t, bar: bars(s0, t), parts: r.parts.map(([left, right]) => ({ left, right })) };
    },
    logText: (_a, r) => `split ${r.parts.map((p: { left: string; right: string }) => `${p.left} into ${p.left} + ${p.right}`).join(', ')} at bar ${r.bar}`,
  },
  {
    name: 'repeat_clip',
    description:
      'Repeat (loop) a clip: copies placed one after another right after it, or every every_bars bars. Give times (number of copies) ' +
      'or until_bar (keep repeating through the end of that bar; the last copy is cut there). Defaults to the selected clip.',
    parameters: obj({
      clip_id: str('Clip id; omit for the selected clip'),
      times: num('Number of copies (1-64)'),
      until_bar: num('Or: repeat through this bar (inclusive), e.g. 16'),
      every_bars: num('Spacing in bars between copy starts; default: the clip length (copies touch)'),
    }),
    run: (ctx, a) => {
      const s0 = ctx.store.get();
      const [id] = targetClips(s0, a);
      if (a.times === undefined && a.until_bar === undefined) throw new S.SessionError('give times or until_bar');
      const times = a.times === undefined ? 64 : Math.round(a.times);
      if (!(times >= 1 && times <= 64)) throw new S.SessionError('times must be 1-64');
      const until = a.until_bar === undefined ? undefined : S.barToSeconds(s0, a.until_bar + 1);
      const every = a.every_bars === undefined ? undefined : a.every_bars * barLength(s0);
      const r = repeatClip(s0, id, times, every, until);
      ctx.store.set(r.session);
      const last = S.findClip(r.session, r.clips[r.clips.length - 1]).clip;
      return { clip_id: id, copies: r.clips, through_bar: Math.ceil(bars(s0, last.start + last.duration) - 1 - 1e-6) };
    },
    logText: (_a, r) => `repeated ${r.clip_id} ${r.copies.length} time(s) through bar ${r.through_bar}`,
  },
  {
    name: 'delete_bars',
    description:
      'Delete a bar range, e.g. "delete bars 5-8" = from_bar 5, to_bar 8 (inclusive). Clips inside go, clips across the edges are cut, ' +
      'and by default everything after moves earlier to close the gap (close_gap false leaves silence). All tracks unless track_ids is given.',
    parameters: obj(
      { from_bar: num('First bar to delete'), to_bar: num('Last bar to delete (inclusive)'), track_ids: ids('Only these tracks; omit for all'), close_gap: bool('Move later material earlier (default true)') },
      ['from_bar', 'to_bar'],
    ),
    run: (ctx, a) => {
      const s0 = ctx.store.get();
      const [x, y] = barRange(s0, a.from_bar, a.to_bar);
      const r = deleteRange(s0, x, y, { trackIds: a.track_ids, closeGap: a.close_gap ?? true });
      ctx.store.set(r.session);
      return { from_bar: a.from_bar, to_bar: a.to_bar, removed: r.removed, cut: r.cut, closed_gap: a.close_gap ?? true };
    },
    logText: (_a, r) => `deleted bars ${r.from_bar}-${r.to_bar}${r.closed_gap ? ' (later material moved up)' : ''}`,
  },
  {
    name: 'insert_bars',
    description: 'Insert empty bars at a bar: everything from there on moves later (clips across it are split). All tracks unless track_ids is given.',
    parameters: obj({ at_bar: num('Where the empty bars go, e.g. 9'), count: num('How many bars'), track_ids: ids('Only these tracks; omit for all') }, ['at_bar', 'count']),
    run: (ctx, a) => {
      const s0 = ctx.store.get();
      const at = timeArg(s0, a.at_bar, undefined)!;
      if (!(a.count > 0)) throw new S.SessionError('count must be > 0');
      edit(ctx, (s) => insertTime(s, at, a.count * barLength(s), a.track_ids));
      return { at_bar: a.at_bar, count: a.count };
    },
    logText: (_a, r) => `inserted ${r.count} empty bar(s) at bar ${r.at_bar}`,
  },
  {
    name: 'copy_bars',
    description:
      'Copy a bar range to another bar, e.g. "copy bars 1-4 to bar 9" = from_bar 1, to_bar 4, to_bar_start 9. Clips are cut to the range; ' +
      'the copies are new clips layered over whatever is at the destination. All tracks unless track_ids is given.',
    parameters: obj(
      { from_bar: num('First bar to copy'), to_bar: num('Last bar to copy (inclusive)'), dest_bar: num('Bar where the copy starts'), track_ids: ids('Only these tracks; omit for all') },
      ['from_bar', 'to_bar', 'dest_bar'],
    ),
    run: (ctx, a) => {
      const s0 = ctx.store.get();
      const [x, y] = barRange(s0, a.from_bar, a.to_bar);
      const r = copyRange(s0, x, y, timeArg(s0, a.dest_bar, undefined)!, a.track_ids);
      ctx.store.set(r.session);
      return { from_bar: a.from_bar, to_bar: a.to_bar, dest_bar: a.dest_bar, clips: r.clips };
    },
    logText: (_a, r) => `copied bars ${r.from_bar}-${r.to_bar} to bar ${r.dest_bar} (${r.clips.join(', ')})`,
  },

  // ---- mix ----
  {
    name: 'set_pan',
    description: 'Pan a track: -1 = hard left, 0 = centre, 1 = hard right ("30% left" = -0.3). Uses the track\'s Utility device (added if missing).',
    parameters: obj({ track_id: str('Track id'), pan: num('-1 to 1', { minimum: -1, maximum: 1 }) }, ['track_id', 'pan']),
    run: (ctx, a) => {
      const r = setPan(ctx.store.get(), a.track_id, a.pan);
      ctx.store.set(r.session);
      return { track_id: a.track_id, pan: a.pan, device_id: r.deviceId, ...(r.inserted ? { inserted_utility: true } : {}) };
    },
    logText: (_a, r) => `panned ${r.track_id} to ${r.pan === 0 ? 'centre' : `${Math.round(Math.abs(r.pan) * 100)}% ${r.pan < 0 ? 'left' : 'right'}`}`,
  },

  // ---- tracks ----
  {
    name: 'duplicate_track',
    description: 'Duplicate a track right below it: its clips (unless with_clips is false), effect chain, gain and mute. The copy is named "<name> copy".',
    parameters: obj({ track_id: str('Track id'), with_clips: bool('Copy the clips too (default true)') }, ['track_id']),
    run: (ctx, a) => {
      let t!: S.Track;
      edit(ctx, (s) => {
        const [s1, copy] = duplicateTrack(s, a.track_id, a.with_clips ?? true);
        t = copy;
        return s1;
      });
      return { from: a.track_id, track_id: t.id, name: t.name, clips: t.clips.map((c) => c.id), devices: t.devices.length };
    },
    logText: (_a, r) => `duplicated track ${r.from} as ${r.track_id} "${r.name}"`,
  },
  {
    name: 'set_track_color',
    description: `Colour a track (its header and regions). Colours: ${TRACK_COLOR_NAMES.join(', ')} (red/orange = coral, violet = purple).`,
    parameters: obj({ track_id: str('Track id'), color: str('Colour name') }, ['track_id', 'color']),
    run: (ctx, a) => {
      const s = edit(ctx, (s) => setTrackColor(s, a.track_id, a.color));
      return { track_id: a.track_id, color: colorName(S.getTrack(s, a.track_id).color, 0) };
    },
    logText: (_a, r) => `coloured track ${r.track_id} ${r.color}`,
  },

  // ---- edit ----
  {
    name: 'set_fade',
    description: 'Fade a clip in and/or out: lengths in seconds (0 removes the fade; at most the clip length). Defaults to the selected clips.',
    parameters: obj({
      clip_id: str('Clip id; omit for the selected clips'),
      clip_ids: ids('Or: several clips'),
      fade_in: num('Fade-in length (s)'),
      fade_out: num('Fade-out length (s)'),
    }),
    run: (ctx, a) => {
      if (a.fade_in === undefined && a.fade_out === undefined) throw new S.SessionError('give fade_in and/or fade_out');
      const list = targetClips(ctx.store.get(), a);
      const s = edit(ctx, (s) => list.reduce((x, id) => setFades(x, id, a.fade_in, a.fade_out), s));
      return { clips: list.map((id) => ({ clip_id: id, fade_in: S.findClip(s, id).clip.fadeIn ?? 0, fade_out: S.findClip(s, id).clip.fadeOut ?? 0 })) };
    },
    logText: (_a, r) => `set fades on ${r.clips.map((c: { clip_id: string; fade_in: number; fade_out: number }) => `${c.clip_id} (in ${c.fade_in}s, out ${c.fade_out}s)`).join(', ')}`,
  },
];
