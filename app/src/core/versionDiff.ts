// What changed between two sessions, as short lines a person can scan (the Versions log, B11):
// "+" added, "-" removed, "~" changed. Like a commit's diff stat, but in music words: tracks,
// clips, devices and knob moves, tempo. View state (transport, selection, lane heights) is not
// a change.
import { formatValue, getDevice, getParam, type DeviceDef } from '../fx/catalog';
import type { Clip, DeviceInstance, Session, Track } from './session';

export type ChangeOp = '+' | '-' | '~';
export interface Change {
  op: ChangeOp;
  text: string;
}

const num = (x: number, d = 1) => (Math.round(x * 10 ** d) / 10 ** d).toString();
const db = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${num(Math.abs(x))} dB`;
const q = (name: string) => `“${name}”`;

function device(kind: string): DeviceDef | null {
  try {
    return getDevice(kind);
  } catch {
    return null;
  }
}
const deviceLabel = (kind: string) => device(kind)?.label ?? kind;

/** "Reverb mix 20% → 45%" lines for one device's knobs (at most 3, then a count). */
function knobChanges(kind: string, a: DeviceInstance, b: DeviceInstance): string[] {
  const dev = device(kind);
  const ids = [...new Set([...Object.keys(a.params), ...Object.keys(b.params)])].filter((id) => a.params[id] !== b.params[id]);
  const fmt = (id: string, v: unknown) => {
    try {
      return dev ? formatValue(getParam(dev, id), v as never) : String(v);
    } catch {
      return String(v);
    }
  };
  const label = (id: string) => dev?.params.find((p) => p.id === id)?.label ?? id;
  const lines = ids.slice(0, 3).map((id) => `${label(id)} ${fmt(id, a.params[id])} → ${fmt(id, b.params[id])}`);
  if (ids.length > 3) lines.push(`${ids.length - 3} more`);
  return lines;
}

function clipChanges(s: Session, t: Track, a: Clip, b: Clip): Change[] {
  const out: Change[] = [];
  const where = `${q(b.name)} on ${t.name}`;
  if (a.name !== b.name) out.push({ op: '~', text: `clip ${q(a.name)} renamed to ${q(b.name)} on ${t.name}` });
  if (a.start !== b.start) out.push({ op: '~', text: `${where} moved ${num(a.start, 2)}s → ${num(b.start, 2)}s` });
  if (a.offset !== b.offset || a.duration !== b.duration) out.push({ op: '~', text: `${where} trimmed to ${num(b.duration, 2)}s` });
  if (a.sourceId !== b.sourceId) out.push({ op: '~', text: `${where} now plays its ${s.sources[b.sourceId]?.processed ?? 'original'} audio` });
  if (a.midi && b.midi) {
    const key = (n: { pitch: number; start: number; duration: number; velocity: number }) => `${n.pitch}@${n.start}/${n.duration}/${n.velocity}`;
    const ka = new Set(a.midi.notes.map(key)), kb = new Set(b.midi.notes.map(key));
    const added = [...kb].filter((k) => !ka.has(k)).length, removed = [...ka].filter((k) => !kb.has(k)).length;
    if (added || removed) {
      const edits = a.midi.notes.length === b.midi.notes.length ? `${added} note${added === 1 ? '' : 's'} edited` : `notes +${added} −${removed}`;
      out.push({ op: '~', text: `${where}: ${edits}` });
    }
    if (a.midi.instrument !== b.midi.instrument) out.push({ op: '~', text: `${where} now plays ${b.midi.instrument}` });
  }
  return out;
}

function trackChanges(s: Session, a: Track, b: Track): Change[] {
  const out: Change[] = [];
  if (a.name !== b.name) out.push({ op: '~', text: `track ${q(a.name)} renamed to ${q(b.name)}` });
  if (a.gainDb !== b.gainDb) out.push({ op: '~', text: `${b.name} volume ${db(a.gainDb)} → ${db(b.gainDb)}` });
  if (a.muted !== b.muted) out.push({ op: '~', text: `${b.name} ${b.muted ? 'muted' : 'unmuted'}` });
  if (a.soloed !== b.soloed) out.push({ op: '~', text: `${b.name} ${b.soloed ? 'soloed' : 'unsoloed'}` });

  // devices: by instance id, so a moved or retuned device is a change, not remove + add
  const da = new Map(a.devices.map((d) => [d.id, d])), dbm = new Map(b.devices.map((d) => [d.id, d]));
  for (const d of b.devices) if (!da.has(d.id)) out.push({ op: '+', text: `${deviceLabel(d.kind)} on ${b.name}` });
  for (const d of a.devices) if (!dbm.has(d.id)) out.push({ op: '-', text: `${deviceLabel(d.kind)} on ${b.name}` });
  for (const d of b.devices) {
    const old = da.get(d.id);
    if (!old) continue;
    if (old.on !== d.on) out.push({ op: '~', text: `${deviceLabel(d.kind)} on ${b.name} turned ${d.on ? 'on' : 'off'}` });
    const knobs = knobChanges(d.kind, old, d);
    if (knobs.length) out.push({ op: '~', text: `${b.name} ${deviceLabel(d.kind)}: ${knobs.join(', ')}` });
  }
  const order = (ds: DeviceInstance[], keep: Set<string>) => ds.filter((d) => keep.has(d.id)).map((d) => d.id).join();
  const both = new Set(a.devices.filter((d) => dbm.has(d.id)).map((d) => d.id));
  if (order(a.devices, both) !== order(b.devices, both)) out.push({ op: '~', text: `${b.name} devices reordered` });

  const ca = new Map(a.clips.map((c) => [c.id, c])), cb = new Map(b.clips.map((c) => [c.id, c]));
  for (const c of b.clips) if (!ca.has(c.id)) out.push({ op: '+', text: `clip ${q(c.name)} on ${b.name}` });
  for (const c of a.clips) if (!cb.has(c.id)) out.push({ op: '-', text: `clip ${q(c.name)} on ${b.name}` });
  for (const c of b.clips) if (ca.has(c.id)) out.push(...clipChanges(s, b, ca.get(c.id)!, c));
  return out;
}

const RANK: Record<ChangeOp, number> = { '+': 0, '-': 1, '~': 2 };

/** What changed going from `a` to `b`: additions, then removals, then edits (the Versions log
 *  previews the first few lines, and something added or gone matters most). */
export function diffSessions(a: Session, b: Session): Change[] {
  return changes(a, b).sort((x, y) => RANK[x.op] - RANK[y.op]);
}

function changes(a: Session, b: Session): Change[] {
  const out: Change[] = [];
  const ta = new Map(a.tracks.map((t) => [t.id, t])), tb = new Map(b.tracks.map((t) => [t.id, t]));
  for (const t of b.tracks) {
    const old = ta.get(t.id);
    if (!old) {
      const clips = t.clips.length ? ` (${t.clips.length} clip${t.clips.length > 1 ? 's' : ''})` : '';
      out.push({ op: '+', text: `track ${q(t.name)}${clips}` });
    } else out.push(...trackChanges(b, old, t));
  }
  for (const t of a.tracks) if (!tb.has(t.id)) out.push({ op: '-', text: `track ${q(t.name)}` });
  const both = (ts: Track[]) => ts.filter((t) => ta.has(t.id) && tb.has(t.id)).map((t) => t.id).join();
  if (both(a.tracks) !== both(b.tracks)) out.push({ op: '~', text: 'tracks reordered' });

  // sounds that arrived or left without a clip change saying so (Ideas, drum pads)
  const onClip = (s: Session) => new Set(s.tracks.flatMap((t) => t.clips.map((c) => c.sourceId)));
  const ua = onClip(a), ub = onClip(b);
  for (const src of Object.values(b.sources)) {
    if (!a.sources[src.id] && src.origin !== 'generated' && src.origin !== 'processed' && !ub.has(src.id)) {
      out.push({ op: '+', text: `sound ${q(src.name)} in Ideas` });
    }
  }
  for (const src of Object.values(a.sources)) if (!b.sources[src.id] && src.origin !== 'generated' && src.origin !== 'processed' && !ua.has(src.id)) out.push({ op: '-', text: `sound ${q(src.name)}` });

  const ka = a.kits ?? {}, kb = b.kits ?? {};
  for (const k of Object.values(kb)) {
    if (!ka[k.id]) out.push({ op: '+', text: `sample pad ${q(k.name)}` });
    else if (JSON.stringify(ka[k.id]) !== JSON.stringify(k)) out.push({ op: '~', text: `sample pad ${q(k.name)} edited` });
  }
  for (const k of Object.values(ka)) if (!kb[k.id]) out.push({ op: '-', text: `sample pad ${q(k.name)}` });

  // project settings last: the tracks are what a person looks for first
  if (a.tempo !== b.tempo) out.push({ op: '~', text: `tempo ${num(a.tempo)} → ${num(b.tempo)} BPM` });
  if (a.timeSignature.join('/') !== b.timeSignature.join('/')) out.push({ op: '~', text: `time signature ${a.timeSignature.join('/')} → ${b.timeSignature.join('/')}` });
  if (a.key !== b.key) out.push({ op: '~', text: `key ${a.key ?? 'none'} → ${b.key ?? 'none'}` });
  return out;
}

/** "+2 −1 ~3" counts for a list of changes. */
export function changeStat(changes: Change[]): Record<ChangeOp, number> {
  const stat = { '+': 0, '-': 0, '~': 0 };
  for (const c of changes) stat[c.op]++;
  return stat;
}
