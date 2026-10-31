// Oct 30: the producer's setups, learned on Save (save_project). A setup is a group of tracks the
// user builds the same way in every project, e.g. vocals: "Vocal" in the centre and doubles
// 40% left and right, each with their EQ and compressor (pan is the Utility device's knob, so a
// track's chain carries it). Lattice notices vocal tracks when the user saves and offers to keep
// them as the "Vocal setup"; in a later project it offers it back when a vocal track appears, and
// Muse can add it (apply_setup). Setups span projects: Electron keeps them in setups.json in
// userData (node/setupFile.ts); web and tests keep them in memory.
import * as S from './session';
import * as C from '../fx/chain';
import { getDevice } from '../fx/catalog';
import { chainLibrary, type SavedChain } from '../fx/savedChains';
import type { ToolContext, ToolDef } from './tools';

export interface SetupTrack {
  name: string;
  gainDb: number;
  devices: SavedChain['devices']; // pan included (Utility)
}

export interface Setup {
  name: string; // "Vocal setup"
  tracks: SetupTrack[];
  learnedIn?: string; // the project it was saved from
  savedAt: string;
}

export interface SetupLibrary {
  list(): Setup[];
  get(name: string): Setup | undefined;
  /** Adds or overwrites by name (any case); returns true if one was replaced. */
  save(setup: Setup): boolean;
  remove(name: string): boolean;
}

export class MemorySetupLibrary implements SetupLibrary {
  constructor(protected setups: Setup[] = []) {}
  list() {
    return this.setups;
  }
  get(name: string) {
    return this.setups.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  }
  save(setup: Setup) {
    const had = !!this.get(setup.name);
    this.setups = [...this.setups.filter((x) => x.name.toLowerCase() !== setup.name.toLowerCase()), setup].sort((a, b) => a.name.localeCompare(b.name));
    return had;
  }
  remove(name: string) {
    const had = !!this.get(name);
    this.setups = this.setups.filter((x) => x.name.toLowerCase() !== name.trim().toLowerCase());
    return had;
  }
}

export function setupLibrary(ctx: { setups?: SetupLibrary }): SetupLibrary {
  return (ctx.setups ??= new MemorySetupLibrary());
}

export const VOCAL_SETUP = 'Vocal setup';

// whole words: "Vox L", "Lead Vocal", "BGV 2", "Double R"; never "Voc" inside "Vocoder" or "Lead Synth"
const VOCAL = /\b(vox|vocals?|voc|voice|singer|doubles?|dbl|harmon(y|ies)|harm|bvs?|bgvs?|backing|adlibs?|ad-libs?)\b/i;

/** A vocal track: its name says so, or one of its audio regions' does. */
export function isVocalTrack(s: S.Session, t: S.Track): boolean {
  return VOCAL.test(t.name) || t.clips.some((c) => !c.midi && (VOCAL.test(c.name) || VOCAL.test(s.sources[c.sourceId]?.name ?? '')));
}

export const vocalTracks = (s: S.Session) => s.tracks.filter((t) => isVocalTrack(s, t));

/** A track's pan: the first switched-on Utility device's Pan knob (0 = centre). */
export function trackPan(t: { devices: { kind: string; on: boolean; params: Record<string, unknown> }[] }): number {
  const u = t.devices.find((d) => d.kind === 'utility' && d.on);
  return Number(u?.params.pan ?? 0) || 0;
}

export const panText = (p: number) => (Math.abs(p) < 0.005 ? 'centre' : `${Math.round(Math.abs(p) * 100)}% ${p < 0 ? 'L' : 'R'}`);

/** What a setup track is, in words: "Vocal L: 40% L; Channel EQ, Compressor". */
export function describeTrack(t: SetupTrack) {
  const devices = t.devices.filter((d) => d.kind !== 'utility').map((d) => getDevice(d.kind).label);
  return { name: t.name, pan: panText(trackPan(t)), devices, ...(t.gainDb ? { gain_db: t.gainDb } : {}) };
}

export function setupFrom(tracks: S.Track[], name: string, learnedIn?: string): Setup {
  return {
    name,
    tracks: tracks.map((t) => ({ name: t.name, gainDb: t.gainDb, devices: t.devices.map((d) => ({ kind: d.kind, on: d.on, params: { ...d.params } })) })),
    ...(learnedIn ? { learnedIn } : {}),
    savedAt: new Date().toISOString(),
  };
}

// the same setup whatever the tracks are called: same levels, pans and chains, in order
const shape = (x: Setup) => JSON.stringify(x.tracks.map((t) => [Math.round(t.gainDb * 10), t.devices]));

export interface SetupOffer {
  name: string;
  track_ids: string[];
  tracks: ReturnType<typeof describeTrack>[];
  replaces: boolean; // a saved one with this name differs
}

/** On Save: vocal tracks set up by hand (two or more, or one with effects) that aren't already
 *  the saved Vocal setup. */
export function setupOffer(ctx: ToolContext, s: S.Session): SetupOffer | null {
  const vt = vocalTracks(s);
  if (vt.length < 2 && !vt.some((t) => t.devices.length)) return null;
  const proposal = setupFrom(vt, VOCAL_SETUP);
  const saved = setupLibrary(ctx).get(VOCAL_SETUP);
  if (saved && shape(saved) === shape(proposal)) return null;
  return { name: VOCAL_SETUP, track_ids: vt.map((t) => t.id), tracks: proposal.tracks.map(describeTrack), replaces: !!saved };
}

/** What Muse sees: each saved setup, track by track. */
export function setupsLine(ctx: ToolContext): string | undefined {
  const all = setupLibrary(ctx).list();
  if (!all.length) return undefined;
  const one = (x: Setup) =>
    `${JSON.stringify(x.name)}: ` +
    x.tracks
      .map(describeTrack)
      .map((t) => `${t.name} (${[t.pan, ...t.devices].join(', ')})`)
      .join(', ');
  return `The producer's setups (saved by them, apply_setup adds one): ${all.map(one).join('; ')}.`;
}

/** Put a setup's chains (and levels) on tracks: on `targets` in order, then on new tracks named
 *  as in the setup. A target's own devices are replaced. One store update, so one undo step. */
export function applySetup(s: S.Session, setup: Setup, targets: string[]): { session: S.Session; tracks: { track_id: string; name: string; made: boolean }[] } {
  const out: { track_id: string; name: string; made: boolean }[] = [];
  setup.tracks.forEach((st, i) => {
    let id = targets[i];
    const made = !id;
    if (made) {
      const [s1, t] = S.addTrack(s, st.name);
      s = s1;
      id = t.id;
    }
    s = S.mapTrack(s, id, (t) => ({ ...t, gainDb: st.gainDb, devices: [] }));
    for (const d of st.devices) {
      const [s1, dev] = C.insertDevice(s, id, d.kind, undefined, d.params);
      s = d.on ? s1 : C.setDeviceOn(s1, id, dev.id, false);
    }
    out.push({ track_id: id, name: S.getTrack(s, id).name, made });
  });
  return { session: s, tracks: out };
}

function findSetup(ctx: ToolContext, name: string): Setup {
  const x = setupLibrary(ctx).get(name);
  if (x) return x;
  const names = setupLibrary(ctx).list().map((y) => JSON.stringify(y.name));
  throw new S.SessionError(`no setup "${name}" (${names.length ? `saved: ${names.join(', ')}` : 'none saved yet; the user saves one with Save'})`);
}

const str = (description: string) => ({ type: 'string', description });
const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const ids = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

export const SETUP_TOOLS: ToolDef[] = [
  {
    name: 'list_setups',
    description: 'List the producer\'s saved setups (track groups they build the same way in every project, e.g. their vocal setup), track by track.',
    parameters: obj({}),
    quiet: true,
    run: (ctx) => ({
      setups: setupLibrary(ctx)
        .list()
        .map((x) => ({ name: x.name, tracks: x.tracks.map(describeTrack), ...(x.learnedIn ? { learned_in: x.learnedIn } : {}), saved_at: x.savedAt })),
    }),
  },
  {
    name: 'save_setup',
    description:
      'Keep tracks as one of the producer\'s setups for later projects: their names, levels and whole chains (pan included). ' +
      `Default: the vocal tracks, as "${VOCAL_SETUP}". Use it when the user asks you to remember how they set something up. The first chain is also saved as "<name> chain" for load_chain.`,
    parameters: obj({ name: str(`Setup name (default "${VOCAL_SETUP}")`), track_ids: ids('Tracks, in order (default: the vocal tracks)') }),
    run: (ctx, a) => {
      const s = ctx.store.get();
      const name = String(a.name ?? '').trim() || VOCAL_SETUP;
      const tracks = a.track_ids?.length ? (a.track_ids as string[]).map((id) => S.getTrack(s, id)) : vocalTracks(s);
      if (!tracks.length) throw new S.SessionError('no vocal tracks to save (name them, e.g. "Vocal", "Vocal L"), or give track_ids');
      const setup = setupFrom(tracks, name, ctx.projects?.current().name);
      const replaced = setupLibrary(ctx).save(setup);
      const first = tracks.find((t) => t.devices.length);
      const chain = first && `${name.replace(/\s*setup$/i, '') || name} chain`;
      if (first && chain) chainLibrary(ctx).save({ name: chain, devices: setup.tracks[tracks.indexOf(first)].devices, savedAt: setup.savedAt });
      return { name, tracks: setup.tracks.map(describeTrack), replaced, ...(chain ? { chain_saved: chain } : {}) };
    },
    logText: (_a, r) => `saved "${r.name}" (${r.tracks.map((t: { name: string; pan: string }) => `${t.name} ${t.pan}`).join(', ')})`,
  },
  {
    name: 'apply_setup',
    description:
      'Add one of the producer\'s setups to this project: its chains (pan included) and levels go on the given tracks in order, ' +
      'then on new tracks named as in the setup. Default tracks: the vocal tracks with no effects yet. One undo step.',
    parameters: obj({ name: str(`Setup name (default "${VOCAL_SETUP}")`), track_ids: ids('Existing tracks to set up, in setup order; the rest are made') }),
    run: (ctx, a) => {
      const setup = findSetup(ctx, String(a.name ?? '').trim() || VOCAL_SETUP);
      const s = ctx.store.get();
      const targets = a.track_ids?.length ? (a.track_ids as string[]).map((id) => S.getTrack(s, id).id) : vocalTracks(s).filter((t) => !t.devices.length).map((t) => t.id);
      if (targets.length > setup.tracks.length) targets.length = setup.tracks.length;
      const r = applySetup(s, setup, targets);
      ctx.store.set(r.session);
      return { setup: setup.name, tracks: r.tracks };
    },
    logText: (_a, r) => `added "${r.setup}" (${r.tracks.map((t: { name: string }) => t.name).join(', ')})`,
  },
  {
    name: 'forget_setup',
    description: 'Delete one of the producer\'s saved setups.',
    parameters: obj({ name: str('Setup name') }, ['name']),
    run: (ctx, a) => {
      const x = findSetup(ctx, String(a.name));
      setupLibrary(ctx).remove(x.name);
      return { forgot: x.name };
    },
  },
];
