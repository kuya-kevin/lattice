// Offline tests of the Muse agent loop, replaying recorded live exchanges (tests/fixtures).
import { describe, expect, it } from 'vitest';
import { MuseAgent, MAX_STEPS, type ChatResponse } from '../src/core/agent';
import { freesoundKey, replayChat, runScenario, type Fixture } from '../src/core/scenario';
import { findClip, getTrack } from '../src/core/session';
import { StubSidecar } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import engineer from './fixtures/engineer.json';
import feedback from './fixtures/feedback.json';
import sound from './fixtures/sound.json';
import tempo from './fixtures/tempo.json';

async function replay(f: Fixture) {
  const chat = replayChat(f.responses);
  const run = await runScenario(f, chat, async (q, fl, n) => {
    const hit = f.freesound[freesoundKey(q, fl, n)];
    if (!hit) throw new Error(`no recorded Freesound result for ${q}`);
    return hit;
  });
  expect(chat.remaining()).toBe(0); // every recorded response was consumed
  return run;
}

describe('agent loop (recorded Muse fixtures)', () => {
  it('engineer: trims, sets gain and arms a punch-in from one request', async () => {
    const { store, results } = await replay(engineer as Fixture);
    const s = store.get();
    const tools = results[0].steps.map((x) => x.tool);
    expect(tools).toEqual(expect.arrayContaining(['trim_clip', 'set_gain', 'add_track', 'arm_punch_in']));
    expect(results[0].steps.every((x) => x.outcome.ok)).toBe(true);
    expect(findClip(s, 'c4').clip).toMatchObject({ start: 2, duration: 7 });
    expect(getTrack(s, 't1').gainDb).toBe(-3);
    expect(s.punchIn).toMatchObject({ start: 4, end: 8 });
    expect(s.punchIn!.trackId).not.toMatch(/^t[13]$/); // the new track
    expect(results[0].reply.length).toBeGreaterThan(0);
  });

  it('feedback: the user\'s hand edit reaches Muse on the next turn', async () => {
    const { store, agent, results } = await replay(feedback as Fixture);
    expect(results).toHaveLength(2);
    expect(results[0].steps[0].tool).toBe('set_gain');
    // the user dragged the vocal back to -2 dB by hand; Muse must not override it
    expect(getTrack(store.get(), 't3').gainDb).toBe(-2);
    const userTurns = agent.history.filter((m) => m.role === 'user').map((m) => m.content as string);
    expect(userTurns[0]).not.toContain('user_edits_since_last_turn');
    expect(userTurns[1]).toContain('set_gain {"track_id":"t3","gain_db":-2}');
    expect(results[1].steps.map((x) => x.tool)).toEqual(expect.arrayContaining(['cleanup_noise', 'quantize_drums']));
  });

  it('sound: searches Freesound with timbre filters and sets synth knobs (stub)', async () => {
    const { results } = await replay(sound as Fixture);
    const steps = results[0].steps;
    const search = steps.filter((x) => x.tool === 'search_freesound');
    expect(search.length).toBeGreaterThan(0);
    expect(steps.some((x) => x.tool === 'set_synth_knobs' && x.outcome.ok)).toBe(true);
    expect(results[0].reply).toMatch(/freesound\.org/);
  });

  it('tempo: sets tempo, key and click, and quantizes at the session tempo', async () => {
    const { store, results } = await replay(tempo as Fixture);
    expect(store.get()).toMatchObject({ tempo: 92, key: 'G minor', metronome: { on: true, countIn: true } });
    const q = results[0].steps.find((x) => x.tool === 'quantize_drums');
    expect(q?.outcome).toMatchObject({ ok: true, result: { bpm: 92, stub: true } });
  });
});

describe('agent loop mechanics', () => {
  const ctx = () => ({ store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) });
  const call = (name: string, args: string, id = 'x'): ChatResponse => ({
    message: { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] },
    finish_reason: 'tool_calls',
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  });

  it('stops after MAX_STEPS', async () => {
    const agent = new MuseAgent(ctx(), async () => call('list_tracks', '{}'));
    const r = await agent.send('loop forever');
    expect(r.stoppedEarly).toBe(true);
    expect(r.steps).toHaveLength(MAX_STEPS);
    expect(r.usage.prompt_tokens).toBe(10 * MAX_STEPS);
  });

  it('feeds tool errors back instead of throwing', async () => {
    const chat = replayChat([call('set_gain', '{"track_id":"t9","gain_db":1}'), call('nope', 'not json'), { message: { content: 'sorry' }, finish_reason: 'stop' }]);
    const agent = new MuseAgent(ctx(), chat);
    const r = await agent.send('x');
    expect(r.reply).toBe('sorry');
    expect(r.steps.map((s) => s.outcome.ok)).toEqual([false, false]);
    const toolMsgs = agent.history.filter((m) => m.role === 'tool');
    expect(toolMsgs[0].content).toContain('no track');
    expect(toolMsgs[1].content).toContain('not valid JSON');
  });
});
