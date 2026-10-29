// Sample pads (B12, "drum pads" until Oct 29): a kit of any sounds from the session (library
// sounds, recordings, chops, one-shots) on a 3x3 grid of pads, played from the keyboard like an
// MPC: Q W E / A S D / Z X C. A pad takes the name of the sound put on it unless renamed. Each pad is one sound on
// one General MIDI drum note, so a take recorded on the kit is an ordinary drum MIDI clip
// (`midi.kit` names the kit) and the existing drum summary (kick / snare / hat counts) still
// reads right. Velocity is fixed for now. Pads play their sound once through (one-shot): a
// note's length does not cut it. Kits live on the session; pure ops only.
import type { SampleRef } from './midi';
import { nextId, SessionError, type Session } from './session';

export interface Pad {
  label: string;
  note: number; // GM drum note the pad plays and records
  sample?: SampleRef; // the sound; none = an empty pad (plays the built-in synth drum)
}

export interface Kit {
  id: string;
  name: string;
  pads: Pad[]; // PAD_COUNT, in PAD_KEYS order (top row first)
}

/** Physical keys (KeyboardEvent.code), top row first, as the pads are drawn. */
export const PAD_KEYS = ['KeyQ', 'KeyW', 'KeyE', 'KeyA', 'KeyS', 'KeyD', 'KeyZ', 'KeyX', 'KeyC'] as const;
export const PAD_COUNT = PAD_KEYS.length;
export const padKeyLabel = (i: number) => PAD_KEYS[i].slice(3);

/** Default pad names and GM notes: cymbals on top, kick and snare under the left hand. */
export const DEFAULT_PADS: { label: string; note: number }[] = [
  { label: 'Crash', note: 49 },
  { label: 'Open hat', note: 46 },
  { label: 'Hat', note: 42 },
  { label: 'Clap', note: 39 },
  { label: 'Tom', note: 45 },
  { label: 'Perc', note: 56 },
  { label: 'Kick', note: 36 },
  { label: 'Snare', note: 38 },
  { label: 'Rim', note: 37 },
];

/** Every pad plays at this velocity (fixed for now). */
export const PAD_VELOCITY = 100;

/** Pad index for a key code, or -1. */
export const padForKey = (code: string) => (PAD_KEYS as readonly string[]).indexOf(code);

export function getKit(s: Session, kitId: string): Kit {
  const k = s.kits?.[kitId];
  if (!k) throw new SessionError(`no kit "${kitId}" (kits: ${Object.keys(s.kits ?? {}).join(', ') || 'none'})`);
  return k;
}

function checkPad(pad: number): number {
  if (!Number.isInteger(pad) || pad < 0 || pad >= PAD_COUNT) throw new SessionError(`pad must be 0-${PAD_COUNT - 1} (top row first: ${PAD_KEYS.map((_, i) => padKeyLabel(i)).join(' ')})`);
  return pad;
}

const putKit = (s: Session, k: Kit): Session => ({ ...s, kits: { ...(s.kits ?? {}), [k.id]: k } });

export function createKit(s: Session, name?: string): [Session, Kit] {
  const [s1, id] = nextId(s, 'k');
  const n = name?.trim() || `Sample pad ${Object.keys(s.kits ?? {}).length + 1}`;
  const kit: Kit = { id, name: n, pads: DEFAULT_PADS.map((p) => ({ ...p })) };
  return [putKit(s1, kit), kit];
}

export function renameKit(s: Session, kitId: string, name: string): Session {
  const n = name.trim();
  if (!n) throw new SessionError('kit name cannot be empty');
  return putKit(s, { ...getKit(s, kitId), name: n });
}

/** A pad still called what it was made as (or after the sound it had): it takes the next sound's name. */
const autoLabel = (s: Session, p: Pad, i: number) =>
  p.label === DEFAULT_PADS[i]?.label || (!!p.sample && p.label === s.sources[p.sample.sourceId]?.name);

/** Put a sound (a whole source) on a pad; `label` renames the pad, else a pad with its default
 *  name takes the sound's. */
export function setPad(s: Session, kitId: string, pad: number, sourceId: string, label?: string): Session {
  const kit = getKit(s, kitId);
  checkPad(pad);
  const src = s.sources[sourceId];
  if (!src) throw new SessionError(`no source "${sourceId}"`);
  if (src.origin === 'generated') throw new SessionError(`source ${sourceId} is a MIDI clip, not audio`);
  const pads = kit.pads.map((p, i) =>
    i === pad ? { ...p, label: label?.trim() || (autoLabel(s, p, i) ? src.name : p.label), sample: { sourceId, offset: 0, duration: src.duration, root: p.note } } : p,
  );
  return putKit(s, { ...kit, pads });
}

/** Pad `i` with its sound taken off (a pad named after the sound gets its default name back). */
export const emptyPad = (s: Session, p: Pad, i: number): Pad => ({ label: autoLabel(s, p, i) ? DEFAULT_PADS[i].label : p.label, note: p.note });

/** Rename one pad (its label on the pad and in the Piano Roll). */
export function renamePad(s: Session, kitId: string, pad: number, label: string): Session {
  const kit = getKit(s, kitId);
  checkPad(pad);
  const n = label.trim();
  if (!n) throw new SessionError('pad name cannot be empty');
  return putKit(s, { ...kit, pads: kit.pads.map((p, i) => (i === pad ? { ...p, label: n } : p)) });
}

/** Take the sound off a pad; a pad named after that sound gets its default name back. */
export function clearPad(s: Session, kitId: string, pad: number): Session {
  const kit = getKit(s, kitId);
  checkPad(pad);
  return putKit(s, { ...kit, pads: kit.pads.map((p, i) => (i === pad ? emptyPad(s, p, i) : p)) });
}

/** Remove a kit. Takes recorded on it stay, playing the built-in drum sounds. */
export function deleteKit(s: Session, kitId: string): Session {
  getKit(s, kitId);
  const { [kitId]: _, ...kits } = s.kits ?? {};
  return {
    ...s,
    kits,
    tracks: s.tracks.map((t) =>
      t.clips.some((c) => c.midi?.kit === kitId)
        ? { ...t, clips: t.clips.map((c) => (c.midi?.kit === kitId ? { ...c, midi: { ...c.midi, kit: undefined } } : c)) }
        : t,
    ),
  };
}

/** The pad that plays a note in a kit (undefined: not a pad note). */
export const padForNote = (k: Kit, note: number) => k.pads.find((p) => p.note === note);

/** Sources a kit's pads use. */
export const kitSources = (k: Kit) => new Set(k.pads.flatMap((p) => (p.sample ? [p.sample.sourceId] : [])));

/** Stable text of what each pad plays (to know when a kit clip's render is stale). */
export const kitSignature = (k: Kit | undefined) => (k ? k.pads.map((p) => `${p.note}:${p.sample?.sourceId ?? ''}`).join(',') : '');

/** One summary line per kit for Muse, e.g. `k3 "Lo-fi": Q crash=Dusty crash, ..., 2 empty`. */
export function describeKits(s: Session): string {
  const kits = Object.values(s.kits ?? {});
  if (!kits.length) return '';
  const line = (k: Kit) => {
    const filled = k.pads.map((p, i) => (p.sample ? `${padKeyLabel(i)} ${p.label.toLowerCase()}(${p.note})=${s.sources[p.sample.sourceId]?.name ?? p.sample.sourceId}` : null)).filter(Boolean);
    const empty = PAD_COUNT - filled.length;
    return `- ${k.id} "${k.name}": ${filled.join(', ') || 'no sounds yet'}${empty ? `; ${empty} empty` : ''}`;
  };
  return `Sample pads (any sounds on 9 pads; set_pad puts a sound on a pad; takes on a kit are drum MIDI clips, one note per pad):\n${kits.map(line).join('\n')}`;
}
