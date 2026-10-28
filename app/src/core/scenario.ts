// Scripted agent scenarios: the same runner records live Muse exchanges to a fixture
// (scripts/record-fixtures.ts) and replays them offline in tests.
import { MuseAgent, type ChatFn, type ChatResponse, type TurnResult, type Usage } from './agent';
import type { FreesoundFilters, FreesoundHit } from './freesound';
import { StubSidecar } from './sidecar';
import { SessionStore } from './store';
import { runTool, type ToolContext } from './tools';

export interface ToolStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface Scenario {
  name: string;
  setup: ToolStep[]; // user actions before the first message
  turns: { user: string; editsBefore?: ToolStep[] }[];
}

type SearchResult = { count: number; results: FreesoundHit[] };

export interface Fixture extends Scenario {
  model: string;
  recordedAt: string;
  responses: ChatResponse[]; // every Muse reply, in call order
  freesound: Record<string, SearchResult>; // recorded search results keyed by freesoundKey()
  usage: Usage;
}

export const freesoundKey = (q: string, f: FreesoundFilters, n: number) => JSON.stringify([q, f, n]);

export function replayChat(responses: ChatResponse[]): ChatFn & { remaining(): number } {
  let i = 0;
  const chat: ChatFn = async () => {
    if (i >= responses.length) throw new Error(`fixture exhausted after ${responses.length} responses`);
    return responses[i++];
  };
  return Object.assign(chat, { remaining: () => responses.length - i });
}

export async function runScenario(
  sc: Scenario,
  chat: ChatFn,
  searchFreesound: ToolContext['searchFreesound'],
): Promise<{ store: SessionStore; agent: MuseAgent; results: TurnResult[] }> {
  const store = new SessionStore();
  const ctx: ToolContext = { store, sidecar: new StubSidecar(), searchFreesound };
  const userDo = async (steps: ToolStep[] = []) => {
    for (const s of steps) {
      const r = await runTool(ctx, s.tool, s.args, 'user');
      if (!r.ok) throw new Error(`setup step ${s.tool} failed: ${r.error}`);
    }
  };
  await userDo(sc.setup);
  store.takeUserEdits(); // setup isn't feedback
  const agent = new MuseAgent(ctx, chat);
  const results: TurnResult[] = [];
  for (const turn of sc.turns) {
    await userDo(turn.editsBefore);
    results.push(await agent.send(turn.user));
  }
  return { store, agent, results };
}

const imp = (source_id: string, name: string, duration: number): ToolStep => ({ tool: 'import_audio', args: { source_id, name, duration, origin: 'import' } });

/** The scenarios we record. Keep them few: each costs a handful of live calls. */
export const SCENARIOS: Scenario[] = [
  {
    name: 'engineer',
    setup: [imp('src-drums', 'Drum loop', 8), imp('src-vocal', 'Vocal take', 12)],
    turns: [{ user: 'Trim the vocal so it plays from 2 to 9 seconds, bring the drums down 3 dB, and set me up to punch in on a new track from 4 to 8 seconds.' }],
  },
  {
    name: 'feedback',
    setup: [imp('src-drums', 'Drum loop', 8), imp('src-vocal', 'Vocal take', 12)],
    turns: [
      { user: 'The vocal is too loud. Turn it down.' },
      {
        // The user disagrees with Muse's amount and drags the fader back up by hand.
        editsBefore: [{ tool: 'set_gain', args: { track_id: 't3', gain_db: -2 } }],
        user: 'Ok. Now also clean up the noise on the vocal and quantize the drums to 16ths, not too hard.',
      },
    ],
  },
  {
    name: 'tempo',
    setup: [imp('src-drums', 'Drum loop', 8)],
    turns: [{ user: 'This beat is 92 BPM in G minor. Set that up, turn the click on with a count-in, then tighten the drums to 8ths.' }],
  },
  {
    name: 'sound',
    setup: [imp('src-hum', 'Hum voice note', 6)],
    turns: [{ user: 'I want a dark, warm synth bass for this hum. Find a few short candidates on Freesound and set up a starting patch on our synth.' }],
  },
  // B1: sound words -> effect moves. Record the baseline first (before suggest_moves exists),
  // copy those to tests/fixtures/baseline/, then record again. Names start with "fx-".
  ...fxScenarios(),
];

/** One mix with four named tracks; each phrase is one fx- scenario on it. */
function fxScenarios(): Scenario[] {
  const mix = [imp('src-vocal', 'Vocal take', 12), imp('src-bass', 'Bass DI', 8), imp('src-drums', 'Drum loop', 8), imp('src-pad', 'Pad', 8)];
  const phrases: [string, string[]][] = [
    ['stand-out', ['Make the vocal stand out in the mix.']],
    ['harsh', ['The vocal sounds harsh, can you smooth it out?']],
    ['sibilant', ['The S sounds on the vocal are too sharp.']],
    ['warm-bass', ['Make the bass warmer.']],
    ['muddy-bass', ['The bass is muddy.']],
    ['punchy-drums', ['Make the drums punchier.']],
    ['glue-drums', ['Glue the drums together a bit.']],
    ['wide-pad', ['Make the pad wider and more spacious.']],
    ['gritty-bass', ['Give the bass some grit.', 'Too much, back it off a bit.']],
    ['telephone', ['Make the vocal sound like it is coming through a phone.']],
  ];
  return phrases.map(([name, turns]) => ({ name: `fx-${name}`, setup: mix, turns: turns.map((user) => ({ user })) }));
}
