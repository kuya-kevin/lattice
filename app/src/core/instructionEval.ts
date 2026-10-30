// B16 instruction eval: about 30 concrete instructions across the five families Muse must act
// on (arrange, mix, tracks, edit, devices), plus vague sound requests it must answer with one
// question. Each case says what the session should look like afterwards, checked on the result,
// not on which tools Muse picked. `ideal` is one correct tool sequence: tests/instructions.test.ts
// runs it offline to prove each case is doable with Muse's tools and that its check is right.
// Live replies are recorded per case as tests/fixtures/instr-<id>.json (scripts/record-fixtures.ts)
// and replayed by the same test; cases without a recording are skipped.
import type { Scenario, ToolStep } from './scenario';
import type { Session, Track } from './session';

export type Family = 'arrange' | 'mix' | 'tracks' | 'edit' | 'devices' | 'ask';

export interface CheckInput {
  before: Session;
  after: Session;
  reply: string;
  steps: { tool: string; args: unknown; ok: boolean }[];
}

export interface InstructionCase {
  id: string;
  family: Family;
  say: string;
  /** user actions after the shared setup (selection, a device to change, ...) */
  before?: ToolStep[];
  /** one correct way, as Muse's tool calls, and a reply */
  ideal: ToolStep[];
  idealReply: string;
  /** problems with the result (empty = pass) */
  check: (x: CheckInput) => string[];
}

const step = (tool: string, args: Record<string, unknown> = {}): ToolStep => ({ tool, args });

// The shared mix, 120 BPM 4/4 (a bar is 2 s). Ids after setup:
//   t1 "Drums" c2 0-8 s (bars 1-4)     t3 "Bass" c4 0-16 s (bars 1-8)
//   t5 "Vocal" c6 8-16 s (bars 5-8)    t7 "Vocal Double" c8 8-16 s (bars 5-8)
//   t9 "Keys"  c11 MIDI 0-8 s, four notes slightly off the 1/16 grid
export const INSTRUCTION_SETUP: ToolStep[] = [
  step('import_audio', { source_id: 'src-drums', name: 'Drums', duration: 8 }),
  step('import_audio', { source_id: 'src-bass', name: 'Bass', duration: 16 }),
  step('import_audio', { source_id: 'src-vocal', name: 'Vocal', duration: 8 }),
  step('move_clip', { clip_id: 'c6', start: 8 }),
  step('import_audio', { source_id: 'src-double', name: 'Vocal Double', duration: 8 }),
  step('move_clip', { clip_id: 'c8', start: 8 }),
  step('add_track', { name: 'Keys' }),
  step('record_midi', {
    track_id: 't9', start: 0, duration: 8,
    notes: [
      { pitch: 60, velocity: 90, start: 0.03, duration: 0.9 },
      { pitch: 64, velocity: 90, start: 0.52, duration: 0.9 },
      { pitch: 67, velocity: 90, start: 1.07, duration: 0.9 },
      { pitch: 72, velocity: 90, start: 1.49, duration: 0.9 },
    ],
  }),
  step('select', {}), // nothing selected unless a case selects something
];

// ─── check helpers ───

const near = (a: number | undefined, b: number, eps = 0.01) => a !== undefined && Math.abs(a - b) <= eps;
const trackNamed = (s: Session, name: string): Track | undefined => s.tracks.find((t) => t.name.toLowerCase() === name.toLowerCase());
const starts = (t: Track | undefined) => (t?.clips ?? []).map((c) => Math.round(c.start * 1000) / 1000).sort((a, b) => a - b);
/** comparable session content (no transport/selection, which Muse may touch freely) */
const content = (s: Session) => JSON.stringify({ ...s, transport: null, selection: null });

function want(cond: boolean, problem: string): string[] {
  return cond ? [] : [problem];
}

/** One track must match `pred`; every other track's content stays as it was. */
function onlyTrack(x: CheckInput, name: string, pred: (t: Track) => string[]): string[] {
  const t = trackNamed(x.after, name);
  if (!t) return [`no track "${name}"`];
  const others = x.after.tracks.filter((o) => o.id !== t.id);
  const changed = others.filter((o) => JSON.stringify(o) !== JSON.stringify(x.before.tracks.find((b) => b.id === o.id)));
  return [...pred(t), ...changed.map((o) => `track "${o.name}" changed too`)];
}

const field = <K extends keyof Track>(name: string, key: K, value: Track[K]) => (x: CheckInput) =>
  onlyTrack(x, name, (t) => want(JSON.stringify(t[key]) === JSON.stringify(value), `${name}.${String(key)} is ${JSON.stringify(t[key])}, want ${JSON.stringify(value)}`));

const pan = (t: Track) => t.devices.find((d) => d.kind === 'utility')?.params.pan as number | undefined;

const asks = (x: CheckInput) => [
  ...want(content(x.after) === content(x.before), 'the session changed; a vague request should get a question first'),
  ...want(x.reply.includes('?'), `the reply is not a question: "${x.reply}"`),
];

export const INSTRUCTION_CASES: InstructionCase[] = [
  // ---- arrange ----
  {
    id: 'move-to-bar', family: 'arrange', say: 'Move the vocal to bar 9.',
    ideal: [step('move_clip', { clip_id: 'c6', bar: 9 })], idealReply: 'Moved the vocal to bar 9.',
    check: (x) => onlyTrack(x, 'Vocal', (t) => want(near(t.clips[0]?.start, 16), `vocal starts at ${starts(t)}, want 16 s (bar 9)`)),
  },
  {
    id: 'move-this', family: 'arrange', say: 'Move this two bars later.', before: [step('select', { track_id: 't7', clip_id: 'c8' })],
    ideal: [step('move_clips', { bars: 2 })], idealReply: 'Moved the vocal double two bars later, to bar 7.',
    check: (x) => onlyTrack(x, 'Vocal Double', (t) => want(near(t.clips[0]?.start, 12), `double starts at ${starts(t)}, want 12 s (bar 7)`)),
  },
  {
    id: 'copy-to-bar', family: 'arrange', say: 'Copy the drums to bar 5.',
    ideal: [step('duplicate_clip', { clip_id: 'c2', bar: 5 })], idealReply: 'Copied the drums to bar 5.',
    check: (x) => onlyTrack(x, 'Drums', (t) => want(JSON.stringify(starts(t)) === '[0,8]', `drum clips start at ${starts(t)}, want 0 and 8 s`)),
  },
  {
    id: 'loop-until', family: 'arrange', say: 'Loop the drums through bar 16.',
    ideal: [step('repeat_clip', { clip_id: 'c2', until_bar: 16 })], idealReply: 'Looped the drums through bar 16.',
    check: (x) => onlyTrack(x, 'Drums', (t) => {
      const end = Math.max(...t.clips.map((c) => c.start + c.duration));
      return [...want(near(end, 32), `drums end at ${end} s, want 32 s (end of bar 16)`), ...want(starts(t).join() === '0,8,16,24', `drum clips start at ${starts(t)}`)];
    }),
  },
  {
    id: 'repeat-twice', family: 'arrange', say: 'Repeat the keys part twice.',
    ideal: [step('repeat_clip', { clip_id: 'c11', times: 2 })], idealReply: 'Repeated the keys twice, through bar 12.',
    check: (x) => onlyTrack(x, 'Keys', (t) => want(starts(t).join() === '0,8,16', `keys clips start at ${starts(t)}, want 0, 8, 16 s`)),
  },
  {
    id: 'delete-bars', family: 'arrange', say: 'Delete bars 3 and 4.',
    ideal: [step('delete_bars', { from_bar: 3, to_bar: 4 })], idealReply: 'Deleted bars 3 and 4; everything after moved up.',
    check: (x) => {
      const bass = trackNamed(x.after, 'Bass');
      const vocal = trackNamed(x.after, 'Vocal');
      const bassLen = (bass?.clips ?? []).reduce((n, c) => n + c.duration, 0);
      return [
        ...want(near(bassLen, 12), `bass plays ${bassLen} s, want 12 s`),
        ...want(near(vocal?.clips[0]?.start, 4), `vocal starts at ${starts(vocal)}, want 4 s (bar 3)`),
      ];
    },
  },
  {
    id: 'split-at-bar', family: 'arrange', say: 'Split the bass at bar 5.',
    ideal: [step('split_clip', { clip_id: 'c4', bar: 5 })], idealReply: 'Split the bass at bar 5.',
    check: (x) => onlyTrack(x, 'Bass', (t) => want(t.clips.length === 2 && starts(t).join() === '0,8' && near(t.clips.reduce((n, c) => n + c.duration, 0), 16), `bass clips ${t.clips.map((c) => `${c.start}+${c.duration}`)}`)),
  },
  {
    id: 'insert-bars', family: 'arrange', say: 'Insert two empty bars at bar 5.',
    ideal: [step('insert_bars', { at_bar: 5, count: 2 })], idealReply: 'Added two empty bars at bar 5.',
    check: (x) => [
      ...want(near(trackNamed(x.after, 'Vocal')?.clips[0]?.start, 12), 'vocal should start at 12 s (bar 7)'),
      ...want(starts(trackNamed(x.after, 'Bass')).join() === '0,12', `bass clips start at ${starts(trackNamed(x.after, 'Bass'))}, want 0 and 12 s`),
    ],
  },
  {
    id: 'copy-bars', family: 'arrange', say: 'Copy the vocal in bars 5-8 to bar 13.',
    ideal: [step('copy_bars', { from_bar: 5, to_bar: 8, dest_bar: 13, track_ids: ['t5'] })], idealReply: 'Copied the vocal to bar 13.',
    check: (x) => onlyTrack(x, 'Vocal', (t) => want(starts(t).join() === '8,24', `vocal clips start at ${starts(t)}, want 8 and 24 s`)),
  },
  {
    id: 'move-to-track', family: 'arrange', say: 'Put the double on the vocal track at bar 13.',
    ideal: [step('move_clip', { clip_id: 'c8', bar: 13, track_id: 't5' })], idealReply: 'Moved the double onto the vocal track at bar 13.',
    check: (x) => {
      const v = trackNamed(x.after, 'Vocal');
      const moved = v?.clips.find((c) => c.name === 'Vocal Double');
      return want(near(moved?.start, 24), `the double is not on the Vocal track at 24 s (vocal clips: ${v?.clips.map((c) => `${c.name}@${c.start}`)})`);
    },
  },

  // ---- mix ----
  {
    id: 'gain-down', family: 'mix', say: 'Turn the bass down 3 dB.',
    ideal: [step('set_gain', { track_id: 't3', gain_db: -3 })], idealReply: 'Turned the bass down 3 dB.',
    check: field('Bass', 'gainDb', -3),
  },
  {
    id: 'gain-exact', family: 'mix', say: 'Set the drums to minus 6 dB.',
    ideal: [step('set_gain', { track_id: 't1', gain_db: -6 })], idealReply: 'Set the drums to minus 6 dB.',
    check: field('Drums', 'gainDb', -6),
  },
  {
    id: 'pan-left', family: 'mix', say: 'Pan the double 30% left.',
    ideal: [step('set_pan', { track_id: 't7', pan: -0.3 })], idealReply: 'Panned the double 30 percent left.',
    check: (x) => onlyTrack(x, 'Vocal Double', (t) => want(near(pan(t), -0.3), `double pan is ${pan(t)}, want -0.3`)),
  },
  {
    id: 'pan-hard-right', family: 'mix', say: 'Pan the keys hard right.',
    ideal: [step('set_pan', { track_id: 't9', pan: 1 })], idealReply: 'Panned the keys hard right.',
    check: (x) => onlyTrack(x, 'Keys', (t) => want(near(pan(t), 1), `keys pan is ${pan(t)}, want 1`)),
  },
  {
    id: 'mute', family: 'mix', say: 'Mute the drums.',
    ideal: [step('mute', { track_id: 't1' })], idealReply: 'Muted the drums.',
    check: field('Drums', 'muted', true),
  },
  {
    id: 'solo', family: 'mix', say: 'Solo the vocal.',
    ideal: [step('solo', { track_id: 't5' })], idealReply: 'Soloed the vocal.',
    check: field('Vocal', 'soloed', true),
  },
  {
    id: 'unmute', family: 'mix', say: 'Unmute the bass.', before: [step('mute', { track_id: 't3' })],
    ideal: [step('mute', { track_id: 't3', muted: false })], idealReply: 'Unmuted the bass.',
    check: field('Bass', 'muted', false),
  },

  // ---- tracks ----
  {
    id: 'new-track', family: 'tracks', say: 'Add a new track called Guitar.',
    ideal: [step('add_track', { name: 'Guitar' })], idealReply: 'Added a track called Guitar.',
    check: (x) => [...want(!!trackNamed(x.after, 'Guitar'), 'no Guitar track'), ...want(x.after.tracks.length === x.before.tracks.length + 1, 'want exactly one new track')],
  },
  {
    id: 'duplicate-track', family: 'tracks', say: 'Duplicate the vocal track.',
    ideal: [step('duplicate_track', { track_id: 't5' })], idealReply: 'Duplicated the vocal track.',
    check: (x) => {
      const added = x.after.tracks.filter((t) => !x.before.tracks.some((b) => b.id === t.id));
      return [
        ...want(added.length === 1, `want one new track, got ${added.length}`),
        ...want(added.length === 1 && /vocal/i.test(added[0].name) && starts(added[0]).join() === '8', 'the new track should be a vocal copy with its clip at 8 s'),
      ];
    },
  },
  {
    id: 'rename', family: 'tracks', say: 'Rename the double to Harmony.',
    ideal: [step('rename_track', { track_id: 't7', name: 'Harmony' })], idealReply: 'Renamed the double to Harmony.',
    check: (x) => [...want(x.after.tracks.find((t) => t.id === 't7')?.name === 'Harmony', 'track t7 is not called Harmony'), ...want(x.after.tracks.length === x.before.tracks.length, 'track count changed')],
  },
  {
    id: 'colour', family: 'tracks', say: 'Make the drums track blue.',
    ideal: [step('set_track_color', { track_id: 't1', color: 'blue' })], idealReply: 'Made the drums track blue.',
    check: field('Drums', 'color', 3),
  },

  // ---- edit ----
  {
    id: 'quantize-keys', family: 'edit', say: 'Quantize the keys to 16ths.',
    ideal: [step('quantize_midi', { clip_id: 'c11', grid: '1/16' })], idealReply: 'Quantized the keys to 16th notes.',
    check: (x) => onlyTrack(x, 'Keys', (t) => {
      const notes = t.clips[0]?.midi?.notes ?? [];
      const off = notes.filter((n) => Math.abs(n.start / 0.125 - Math.round(n.start / 0.125)) > 0.01);
      return want(notes.length === 4 && !off.length, `notes off the 1/16 grid: ${off.map((n) => n.start)}`);
    }),
  },
  {
    id: 'quantize-drums', family: 'edit', say: 'Quantize the drums to 8ths, full strength.',
    ideal: [step('quantize_drums', { track_id: 't1', grid: '1/8', strength: 1 })], idealReply: 'Quantizing the drums is a stub here, so nothing changed yet.',
    check: (x) => want(x.steps.some((s) => s.tool === 'quantize_drums' && s.ok && (s.args as { grid?: string; strength?: number }).grid === '1/8' && (s.args as { strength?: number }).strength === 1), 'want quantize_drums on the drums at 1/8, strength 1'),
  },
  {
    id: 'transpose-octave', family: 'edit', say: 'Transpose the keys up an octave.',
    ideal: [step('transpose_midi', { clip_id: 'c11', semitones: 12 })], idealReply: 'Moved the keys up an octave.',
    check: (x) => onlyTrack(x, 'Keys', (t) => {
      const p = (t.clips[0]?.midi?.notes ?? []).map((n) => n.pitch).join();
      return want(p === '72,76,79,84', `keys pitches ${p}, want 72,76,79,84`);
    }),
  },
  {
    id: 'trim-bars', family: 'edit', say: 'Trim the bass to bars 1-4.',
    ideal: [step('trim_clip', { clip_id: 'c4', from_bar: 1, to_bar: 4 })], idealReply: 'Trimmed the bass to bars 1 to 4.',
    check: (x) => onlyTrack(x, 'Bass', (t) => want(t.clips.length === 1 && near(t.clips[0].start, 0) && near(t.clips[0].duration, 8), `bass clip ${t.clips.map((c) => `${c.start}+${c.duration}`)}, want 0+8`)),
  },
  {
    id: 'fade-out', family: 'edit', say: 'Fade the vocal out over two seconds.',
    ideal: [step('set_fade', { clip_id: 'c6', fade_out: 2 })], idealReply: 'Added a two second fade-out to the vocal.',
    check: (x) => onlyTrack(x, 'Vocal', (t) => want(near(t.clips[0]?.fadeOut, 2), `vocal fade-out is ${t.clips[0]?.fadeOut}, want 2 s`)),
  },
  {
    id: 'fade-in-this', family: 'edit', say: 'Fade this in over half a second.', before: [step('select', { track_id: 't3', clip_id: 'c4' })],
    ideal: [step('set_fade', { fade_in: 0.5 })], idealReply: 'Faded the bass in over half a second.',
    check: (x) => onlyTrack(x, 'Bass', (t) => want(near(t.clips[0]?.fadeIn, 0.5), `bass fade-in is ${t.clips[0]?.fadeIn}, want 0.5 s`)),
  },

  // ---- devices ----
  {
    id: 'add-eq', family: 'devices', say: 'Add an EQ to the vocal.',
    ideal: [step('insert_device', { track_id: 't5', device: 'eq' })], idealReply: 'Added an EQ to the vocal.',
    check: (x) => onlyTrack(x, 'Vocal', (t) => want(t.devices.map((d) => d.kind).join() === 'eq', `vocal devices: ${t.devices.map((d) => d.kind)}`)),
  },
  {
    id: 'eq-shelf', family: 'devices', say: 'Put an EQ on the vocal with the high shelf up 3 dB.',
    ideal: [step('insert_device', { track_id: 't5', device: 'eq', params: { hs_gain: 3 }, exact: true })], idealReply: 'Added an EQ to the vocal with the high shelf up 3 dB.',
    check: (x) => onlyTrack(x, 'Vocal', (t) => want(t.devices.length === 1 && t.devices[0].kind === 'eq' && t.devices[0].params.hs_gain === 3, `vocal devices: ${JSON.stringify(t.devices.map((d) => [d.kind, d.params.hs_gain]))}`)),
  },
  {
    id: 'knob-exact', family: 'devices', say: 'Set the compressor threshold on the drums to minus 50 dB.', before: [step('insert_device', { track_id: 't1', device: 'comp' })],
    ideal: [step('set_param', { track_id: 't1', device_id: 'comp', param: 'thresh', value: -50, exact: true })], idealReply: 'Set the drum compressor threshold to minus 50 dB.',
    check: (x) => onlyTrack(x, 'Drums', (t) => want(t.devices.length === 1 && t.devices[0].params.thresh === -50, `drum comp threshold is ${t.devices[0]?.params.thresh}, want -50`)),
  },
  {
    id: 'remove-device', family: 'devices', say: 'Remove the EQ from the bass.', before: [step('insert_device', { track_id: 't3', device: 'eq' })],
    ideal: [step('remove_device', { track_id: 't3', device_id: 'eq' })], idealReply: 'Removed the EQ from the bass.',
    check: field('Bass', 'devices', []),
  },

  // ---- vague: ask one short question, change nothing ----
  {
    id: 'vague-better', family: 'ask', say: 'Make it sound better.',
    ideal: [], idealReply: 'Better how: turn the vocal up, or add an EQ to brighten it?',
    check: asks,
  },
  {
    id: 'vague-wider', family: 'ask', say: 'Make the keys wider.',
    ideal: [], idealReply: 'Wider how: pan the keys to one side, or add stereo width with a Utility device?',
    check: asks,
  },
  {
    id: 'vague-open', family: 'ask', say: 'Make the vocal more open.',
    ideal: [], idealReply: 'More open how: raise the top-end EQ, or cut the low-mids?',
    check: asks,
  },
];

/** One single-turn scenario per case, named "instr-<id>" (the fixture name too). */
export function instructionScenarios(): Scenario[] {
  return INSTRUCTION_CASES.map((c) => ({ name: `instr-${c.id}`, setup: [...INSTRUCTION_SETUP, ...(c.before ?? [])], turns: [{ user: c.say }] }));
}
