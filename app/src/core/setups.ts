// Oct 30: the producer's setups, learned from what they do by hand. A setup is a group of tracks
// the user builds the same way in project after project, e.g. vocals: "Vocal" in the centre and
// doubles 40% left and right, each with their EQ and compressor (pan is the Utility device's knob,
// so a track's chain carries it). Nothing here knows about vocals: a group is the tracks whose
// names share a word once sides and numbers are dropped ("Gtr L" / "Gtr R" -> guitar, "Vox" /
// "Vocal L" -> vocal), with at least one set up by hand.
// Learning: each Save (save_project) notes every group's shape (pans and device kinds, not exact
// knob values) for that project. Once the same shape has been seen in `learnAfter` projects (a
// setting, default 2), the notice offers to keep it; a different shape seen that often offers to
// update it. In a later project a bare track of that kind gets the offer to use it (apply_setup),
// and Muse sees the setups. Setups span projects: Electron keeps them in setups.json in userData
// (node/setupFile.ts); web and tests keep them in memory.
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
  family: string; // the kind of track it is for, "vocal" (familyOf)
  tracks: SetupTrack[];
  learnedIn?: string; // the project it was saved from
  savedAt: string;
}

/** A group's shape seen at a Save, one per family per project (the latest Save). */
export interface Sighting {
  family: string;
  project: string;
  shape: string;
  at: string;
}

export interface SetupState {
  setups: Setup[];
  seen: Sighting[];
  declined: { family: string; shape: string; count: number }[]; // "Not now" at that many projects
  learnAfter: number; // projects with the same shape before Lattice offers it
}

export const DEFAULT_LEARN_AFTER = 2;

export class MemorySetupLibrary {
  protected state: SetupState;

  constructor(initial: Partial<SetupState> = {}) {
    this.state = {
      setups: (initial.setups ?? []).map((x) => ({ ...x, family: x.family ?? familyOf(x.name.replace(/\s*setup$/i, '')) ?? x.name.toLowerCase() })),
      seen: initial.seen ?? [],
      declined: initial.declined ?? [],
      learnAfter: initial.learnAfter ?? DEFAULT_LEARN_AFTER,
    };
  }
  /** File-backed libraries write here. */
  protected changed() {}

  list() {
    return this.state.setups;
  }
  get(name: string) {
    return this.state.setups.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  }
  forFamily(family: string) {
    return this.state.setups.find((x) => x.family === family);
  }
  /** Adds or overwrites (same name or same family); returns true if one was replaced. */
  save(setup: Setup) {
    const same = (x: Setup) => x.name.toLowerCase() === setup.name.toLowerCase() || x.family === setup.family;
    const had = this.state.setups.some(same);
    this.state.setups = [...this.state.setups.filter((x) => !same(x)), setup].sort((a, b) => a.name.localeCompare(b.name));
    this.changed();
    return had;
  }
  remove(name: string) {
    const x = this.get(name);
    this.state.setups = this.state.setups.filter((y) => y !== x);
    this.changed();
    return !!x;
  }
  /** Note a group's shape in a project (replacing that project's earlier one); returns how many
   *  projects have this shape now. */
  see(family: string, project: string, shape: string): number {
    this.state.seen = [...this.state.seen.filter((o) => !(o.family === family && o.project === project)), { family, project, shape, at: new Date().toISOString() }];
    this.changed();
    return this.state.seen.filter((o) => o.family === family && o.shape === shape).length;
  }
  declinedAt(family: string, shape: string) {
    return this.state.declined.find((d) => d.family === family && d.shape === shape)?.count ?? 0;
  }
  decline(family: string, shape: string, count: number) {
    this.state.declined = [...this.state.declined.filter((d) => !(d.family === family && d.shape === shape)), { family, shape, count }];
    this.changed();
  }
  get learnAfter() {
    return this.state.learnAfter;
  }
  set learnAfter(n: number) {
    this.state.learnAfter = n;
    this.changed();
  }
}
export type SetupLibrary = MemorySetupLibrary;

export function setupLibrary(ctx: { setups?: SetupLibrary }): SetupLibrary {
  return (ctx.setups ??= new MemorySetupLibrary());
}

// ---- what kind of track a name is ----
// spellings of the same kind; anything else is its own kind ("Gtr" and "Guitar" match, "Sax" is "sax")
const ALIASES: Record<string, string> = {
  vox: 'vocal', vocals: 'vocal', voc: 'vocal', voice: 'vocal', vocalist: 'vocal', singer: 'vocal', bgv: 'vocal', bgvs: 'vocal', bv: 'vocal', bvs: 'vocal',
  gtr: 'guitar', gtrs: 'guitar', guitars: 'guitar', drums: 'drum', kit: 'drum', basses: 'bass', key: 'keys', keyboard: 'keys', keyboards: 'keys',
  pno: 'piano', synths: 'synth', pads: 'pad', strings: 'string', horns: 'horn', harmonies: 'harmony', harm: 'harmony',
};
// sides, positions and takes: "Vocal L", "Gtr Double 2", "Vox Main"
const MODIFIERS = new Set(['l', 'r', 'left', 'right', 'c', 'ctr', 'center', 'centre', 'mid', 'middle', 'main', 'lead', 'double', 'doubles', 'dbl', 'dt', 'dub', 'wide', 'hard', 'take', 'comp', 'a', 'b', 'the', 'my']);
// names that say nothing about the sound
const GENERIC = new Set(['track', 'audio', 'untitled', 'recording', 'rec', 'midi', 'inst', 'instrument', 'new', 'sound', 'region', 'wav', 'mp3', 'aif', 'aiff']);
const DISPLAY: Record<string, string> = { drum: 'Drums', keys: 'Keys', string: 'Strings' };

/** The kind of track a name is: its last word that isn't a side, number or take, in one spelling;
 *  null for names like "Audio 1". */
export function familyOf(name: string): string | null {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !/^\d+$/.test(w) && !MODIFIERS.has(w));
  const head = words[words.length - 1];
  if (!head || GENERIC.has(head)) return null;
  return ALIASES[head] ?? head;
}

/** A track's kind: by its name, else (a take on "Audio 1") by its first audio region's. */
export function trackFamily(s: S.Session, t: S.Track): string | null {
  const own = familyOf(t.name);
  if (own) return own;
  const c = t.clips.find((x) => !x.midi);
  return c ? (familyOf(c.name) ?? familyOf(s.sources[c.sourceId]?.name ?? '')) : null;
}

export const setupNameFor = (family: string) => `${DISPLAY[family] ?? family[0].toUpperCase() + family.slice(1)} setup`;

/** The tracks of each kind that the user set up (two or more, or one with effects). */
export function trackGroups(s: S.Session): { family: string; tracks: S.Track[] }[] {
  const by = new Map<string, S.Track[]>();
  for (const t of s.tracks) {
    const f = trackFamily(s, t);
    if (f) by.set(f, [...(by.get(f) ?? []), t]);
  }
  return [...by].filter(([, ts]) => ts.some((t) => t.devices.length) && (ts.length > 1 || ts[0].devices.length)).map(([family, tracks]) => ({ family, tracks: byPan(tracks) }));
}

// the centre track first (a bare track takes it when applied), then out from the middle, left first
const byPan = <T extends { devices: SetupTrack['devices'] }>(ts: T[]) => [...ts].sort((a, b) => Math.abs(trackPan(a)) - Math.abs(trackPan(b)) || trackPan(a) - trackPan(b));

/** A track's pan: the first switched-on Utility device's Pan knob (0 = centre). */
export function trackPan(t: { devices: { kind: string; on: boolean; params: Record<string, unknown> }[] }): number {
  const u = t.devices.find((d) => d.kind === 'utility' && d.on);
  return Number(u?.params.pan ?? 0) || 0;
}

export const panText = (p: number) => (Math.abs(p) < 0.005 ? 'centre' : `${Math.round(Math.abs(p) * 100)}% ${p < 0 ? 'L' : 'R'}`);

/** Two setups are "the same way" with the same pans (to 5%) and the same devices on each track
 *  (switched on), whatever the tracks are called and wherever the knobs are. */
export function shapeOf(tracks: { devices: SetupTrack['devices'] }[]): string {
  return byPan(tracks)
    .map((t) => `${Math.round(trackPan(t) * 20) / 20}:${t.devices.filter((d) => d.on && d.kind !== 'utility').map((d) => d.kind).join('+')}`)
    .join('|');
}

/** What a setup track is, in words: "Vocal L: 40% L; Channel EQ, Compressor". */
export function describeTrack(t: SetupTrack) {
  const devices = t.devices.filter((d) => d.kind !== 'utility').map((d) => getDevice(d.kind).label);
  return { name: t.name, pan: panText(trackPan(t)), devices, ...(t.gainDb ? { gain_db: t.gainDb } : {}) };
}

export function setupFrom(tracks: S.Track[], name: string, family: string, learnedIn?: string): Setup {
  return {
    name,
    family,
    tracks: byPan(tracks).map((t) => ({ name: t.name, gainDb: t.gainDb, devices: t.devices.map((d) => ({ kind: d.kind, on: d.on, params: { ...d.params } })) })),
    ...(learnedIn ? { learnedIn } : {}),
    savedAt: new Date().toISOString(),
  };
}

export interface SetupOffer {
  name: string; // "Vocal setup" (or the saved one's name)
  family: string;
  shape: string; // for decline_setup
  track_ids: string[];
  tracks: ReturnType<typeof describeTrack>[];
  projects: number; // how many projects have this shape
  replaces: boolean; // updates a saved setup of this kind
}

/** On Save: note each group's shape for this project, and offer the ones seen in enough projects
 *  that aren't the saved setup already (or that the user turned down at this count). */
export function setupOffers(ctx: ToolContext, s: S.Session): SetupOffer[] {
  const lib = setupLibrary(ctx);
  const project = ctx.projects?.current().id ?? 'p1';
  const offers: SetupOffer[] = [];
  for (const g of trackGroups(s)) {
    const shape = shapeOf(g.tracks);
    const projects = lib.see(g.family, project, shape);
    const saved = lib.forFamily(g.family);
    if (saved && shapeOf(saved.tracks) === shape) continue; // known
    if (projects < lib.learnAfter || lib.declinedAt(g.family, shape) >= projects) continue;
    offers.push({
      name: saved?.name ?? setupNameFor(g.family),
      family: g.family,
      shape,
      track_ids: g.tracks.map((t) => t.id),
      tracks: setupFrom(g.tracks, '', g.family).tracks.map(describeTrack),
      projects,
      replaces: !!saved,
    });
  }
  return offers;
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
  return `The producer's setups (learned from their projects, apply_setup adds one): ${all.map(one).join('; ')}.`;
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

/** Tracks of a setup's kind with no effects yet: where applying it starts. */
export const bareTracks = (s: S.Session, family: string) => s.tracks.filter((t) => !t.devices.length && trackFamily(s, t) === family);

function findSetup(ctx: ToolContext, name: string): Setup {
  const lib = setupLibrary(ctx);
  const x = lib.get(name) ?? lib.get(`${name} setup`) ?? (familyOf(name.replace(/\s*setup$/i, '')) ? lib.forFamily(familyOf(name.replace(/\s*setup$/i, ''))!) : undefined);
  if (x) return x;
  const names = lib.list().map((y) => JSON.stringify(y.name));
  throw new S.SessionError(`no setup "${name}" (${names.length ? `saved: ${names.join(', ')}` : 'none saved yet; Lattice offers one when the user sets tracks up the same way and saves'})`);
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
    run: (ctx) => {
      const lib = setupLibrary(ctx);
      return {
        setups: lib.list().map((x) => ({ name: x.name, family: x.family, tracks: x.tracks.map(describeTrack), ...(x.learnedIn ? { learned_in: x.learnedIn } : {}), saved_at: x.savedAt })),
        learn_after: lib.learnAfter,
      };
    },
  },
  {
    name: 'save_setup',
    description:
      'Keep tracks as one of the producer\'s setups for later projects: their names, levels and whole chains (pan included). ' +
      'Give track_ids, or a name like "Vocal setup" for all tracks of that kind. Use it when the user asks you to remember how they set something up. ' +
      'The first chain is also saved as "<kind> chain" for load_chain.',
    parameters: obj({ name: str('Setup name, e.g. "Vocal setup" (default: from the tracks\' names)'), track_ids: ids('Tracks to keep (default: every track of the named kind)') }),
    run: (ctx, a) => {
      const s = ctx.store.get();
      const given = String(a.name ?? '').trim();
      let tracks: S.Track[];
      let family: string | null;
      if (a.track_ids?.length) {
        tracks = (a.track_ids as string[]).map((id) => S.getTrack(s, id));
        family = trackFamily(s, tracks[0]) ?? (given ? familyOf(given.replace(/\s*setup$/i, '')) : null);
      } else {
        family = given ? familyOf(given.replace(/\s*setup$/i, '')) : null;
        tracks = family ? s.tracks.filter((t) => trackFamily(s, t) === family) : [];
      }
      if (!family) throw new S.SessionError('say which tracks (track_ids) or what kind, e.g. name "Vocal setup"');
      if (!tracks.length) throw new S.SessionError(`no ${family} tracks to save (name them, e.g. "${setupNameFor(family).replace(/ setup$/, '')} L"), or give track_ids`);
      const name = given || setupNameFor(family);
      const setup = setupFrom(tracks, /setup$/i.test(name) ? name : `${name} setup`, family, ctx.projects?.current().name);
      const lib = setupLibrary(ctx);
      const replaced = lib.save(setup);
      lib.see(family, ctx.projects?.current().id ?? 'p1', shapeOf(setup.tracks));
      const first = setup.tracks.find((t) => t.devices.some((d) => d.kind !== 'utility'));
      const chain = first && `${setup.name.replace(/\s*setup$/i, '')} chain`;
      if (first && chain) chainLibrary(ctx).save({ name: chain, devices: first.devices, savedAt: setup.savedAt });
      return { name: setup.name, family, tracks: setup.tracks.map(describeTrack), replaced, ...(chain ? { chain_saved: chain } : {}) };
    },
    logText: (_a, r) => `saved "${r.name}" (${r.tracks.map((t: { name: string; pan: string }) => `${t.name} ${t.pan}`).join(', ')})`,
  },
  {
    name: 'decline_setup',
    description: 'The user said "Not now" to keeping a setup: don\'t offer this shape again until it shows up in another project.',
    userOnly: true,
    quiet: true,
    parameters: obj({ family: str(''), shape: str(''), projects: { type: 'number', description: '' } }, ['family', 'shape', 'projects']),
    run: (ctx, a) => (setupLibrary(ctx).decline(String(a.family), String(a.shape), Number(a.projects)), { declined: a.family }),
  },
  {
    name: 'set_setup_learning',
    description: 'How many projects the user sets tracks up the same way in before Lattice offers to keep it as a setup.',
    userOnly: true,
    quiet: true,
    parameters: obj({ after: { type: 'number', description: 'Projects (1-5)' } }, ['after']),
    run: (ctx, a) => {
      const n = Math.round(Number(a.after));
      if (!(n >= 1 && n <= 5)) throw new S.SessionError('after must be 1 to 5 projects');
      setupLibrary(ctx).learnAfter = n;
      return { learn_after: n };
    },
  },
  {
    name: 'apply_setup',
    description:
      'Add one of the producer\'s setups to this project: its chains (pan included) and levels go on the given tracks in order, ' +
      'then on new tracks named as in the setup. Default tracks: this project\'s tracks of that kind with no effects yet. One undo step.',
    parameters: obj({ name: str('Setup name, e.g. "Vocal setup"'), track_ids: ids('Existing tracks to set up, in setup order (centre first); the rest are made') }, ['name']),
    run: (ctx, a) => {
      const setup = findSetup(ctx, String(a.name));
      const s = ctx.store.get();
      const targets = a.track_ids?.length ? (a.track_ids as string[]).map((id) => S.getTrack(s, id).id) : bareTracks(s, setup.family).map((t) => t.id);
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
