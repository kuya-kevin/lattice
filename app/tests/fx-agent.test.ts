// B1 step 6: replay the fx- scenarios recorded with suggest_moves (tests/fixtures/fx-*.json; the
// baseline without it is in tests/fixtures/baseline/). Each phrase must look up the words first,
// end with the right devices on the right track only, and keep every knob inside its usual range.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { replayChat, runScenario, type Fixture } from '../src/core/scenario';
import { getDevice } from '../src/fx/catalog';

const load = (name: string): Fixture => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8'));

// scenario -> [track, devices that must end up on it]
const EXPECT: Record<string, [string, string[]]> = {
  'fx-stand-out': ['t1', ['eq', 'comp']],
  'fx-harsh': ['t1', ['eq']],
  'fx-sibilant': ['t1', ['deess']],
  'fx-warm-bass': ['t3', ['eq', 'sat']],
  'fx-muddy-bass': ['t3', ['eq']],
  'fx-punchy-drums': ['t5', ['comp']],
  'fx-glue-drums': ['t5', ['comp']],
  'fx-wide-pad': ['t7', ['utility', 'reverb']],
  'fx-gritty-bass': ['t3', ['sat']],
  'fx-telephone': ['t1', ['eq', 'sat']],
};

describe('fx scenarios with suggest_moves (recorded Muse fixtures)', () => {
  for (const [name, [track, devices]] of Object.entries(EXPECT)) {
    it(`${name}: looks the words up, then edits only ${track}`, async () => {
      const f = load(name);
      const chat = replayChat(f.responses);
      const { store, results } = await runScenario(f, chat, async () => ({ count: 0, results: [] }));
      expect(chat.remaining()).toBe(0);
      const first = results[0].steps.find((x) => x.tool !== 'list_tracks');
      expect(first?.tool).toBe('suggest_moves');
      for (const r of results) {
        expect(r.stoppedEarly).toBe(false);
        expect(r.steps.filter((x) => !x.outcome.ok), JSON.stringify(r.steps)).toEqual([]);
        // a clamp note means Muse went past the usual range without asking
        expect(r.steps.filter((x) => JSON.stringify(x.outcome).includes('usual range'))).toEqual([]);
      }
      const s = store.get();
      for (const t of s.tracks) {
        if (t.id !== track) expect(t.devices, `${t.name} untouched`).toEqual([]);
        for (const d of t.devices)
          for (const p of getDevice(d.kind).params)
            if (p.agentRange && typeof d.params[p.id] === 'number') {
              expect(d.params[p.id], `${d.kind}.${p.id}`).toBeGreaterThanOrEqual(p.agentRange[0]);
              expect(d.params[p.id], `${d.kind}.${p.id}`).toBeLessThanOrEqual(p.agentRange[1]);
            }
      }
      expect(s.tracks.find((t) => t.id === track)!.devices.map((d) => d.kind)).toEqual(devices);
    });
  }

  it('fx-punchy-drums keeps the slow attack that makes it punchy', async () => {
    const f = load('fx-punchy-drums');
    const { store } = await runScenario(f, replayChat(f.responses), async () => ({ count: 0, results: [] }));
    expect(store.get().tracks.find((t) => t.id === 't5')!.devices[0].params).toMatchObject({ attack: 25, ratio: 4 });
  });

  it('fx-gritty-bass backs the drive off on "too much"', async () => {
    const f = load('fx-gritty-bass');
    const { store, results } = await runScenario(f, replayChat(f.responses), async () => ({ count: 0, results: [] }));
    const drive = (n: number) => results[n].steps.filter((x) => x.tool === 'set_param').map((x) => (x.outcome as { result: { value: number } }).result.value).at(-1);
    expect(drive(1)).toBeLessThan(drive(0)!);
    expect(store.get().tracks.find((t) => t.id === 't3')!.devices[0].params.drive).toBe(drive(1));
  });
});
