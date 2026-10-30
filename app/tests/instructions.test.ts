// B16 instruction eval (src/core/instructionEval.ts). Two parts:
//  1. offline: every case's `ideal` tool calls, run as Muse, must pass its own check. This proves
//     each instruction is doable with the tools Muse is offered, and that the check is right.
//  2. recorded: live Muse replies in tests/fixtures/instr-<id>.json are replayed and checked the
//     same way. A case with no recording is skipped (recording costs money; see the lane note).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTRUCTION_CASES, INSTRUCTION_SETUP, instructionScenarios, type Family } from '../src/core/instructionEval';
import { replayChat, runScenario, type Fixture } from '../src/core/scenario';
import { StubSidecar } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { museToolSpecs, runTool, type ToolContext } from '../src/core/tools';

const RECORD_CMD = "npm run record-fixtures -- 'instr-*'";
const fixturePath = (id: string) => join(import.meta.dirname, 'fixtures', `instr-${id}.json`);

describe('instruction eval: the cases (offline)', () => {
  it('has about 30 cases over every family, with unique ids', () => {
    expect(INSTRUCTION_CASES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(INSTRUCTION_CASES.map((c) => c.id)).size).toBe(INSTRUCTION_CASES.length);
    const per = (f: Family) => INSTRUCTION_CASES.filter((c) => c.family === f).length;
    for (const f of ['arrange', 'mix', 'tracks', 'edit', 'devices'] as Family[]) expect(per(f), f).toBeGreaterThanOrEqual(4);
    expect(per('ask')).toBeGreaterThanOrEqual(3);
    expect(instructionScenarios().map((s) => s.name)).toEqual(INSTRUCTION_CASES.map((c) => `instr-${c.id}`));
  });

  it('every ideal uses only tools Muse is offered', () => {
    const offered = new Set(museToolSpecs().map((t) => t.function.name));
    for (const c of INSTRUCTION_CASES) for (const s of c.ideal) expect(offered.has(s.tool), `${c.id}: ${s.tool}`).toBe(true);
  });

  for (const c of INSTRUCTION_CASES) {
    it(`${c.id}: "${c.say}" -> the ideal calls pass the check, and doing nothing fails it`, async () => {
      const ctx: ToolContext = { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) };
      for (const s of [...INSTRUCTION_SETUP, ...(c.before ?? [])]) expect(await runTool(ctx, s.tool, s.args, 'user'), `${c.id} setup ${s.tool}`).toMatchObject({ ok: true });
      const before = ctx.store.get();
      const steps = [];
      for (const s of c.ideal) {
        const o = await runTool(ctx, s.tool, s.args, 'muse');
        expect(o.ok, `${c.id}: ${s.tool} ${JSON.stringify(o)}`).toBe(true);
        steps.push({ tool: s.tool, args: s.args, ok: o.ok });
      }
      expect(c.check({ before, after: ctx.store.get(), reply: c.idealReply, steps })).toEqual([]);
      // the check must catch a Muse that did nothing (an "ask" case must catch a reply without a question)
      const idle = c.family === 'ask' ? { reply: 'Done.' } : { reply: c.idealReply };
      expect(c.check({ before, after: before, steps: [], ...idle }).length, `${c.id}: check passes on no change`).toBeGreaterThan(0);
    });
  }
});

describe('instruction eval: recorded Muse replies', () => {
  const recorded = INSTRUCTION_CASES.filter((c) => existsSync(fixturePath(c.id)));
  if (!recorded.length) {
    it.skip(`no instr- fixtures recorded yet; record them (costs Meta API money) with: ${RECORD_CMD}`, () => {});
  }
  for (const c of INSTRUCTION_CASES) {
    if (!existsSync(fixturePath(c.id))) {
      it.skip(`${c.id}: no recording (${RECORD_CMD})`, () => {});
      continue;
    }
    it(`${c.id}: "${c.say}"`, async () => {
      const f: Fixture = JSON.parse(readFileSync(fixturePath(c.id), 'utf8'));
      const chat = replayChat(f.responses);
      const { store, agent, results } = await runScenario(f, chat, async () => ({ count: 0, results: [] }));
      expect(chat.remaining()).toBe(0);
      const r = results[0];
      expect(r.stoppedEarly).toBe(false);
      // the session before Muse's turn: the scenario's setup, replayed without Muse
      const ctx: ToolContext = { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) };
      for (const s of f.setup) await runTool(ctx, s.tool, s.args, 'user');
      const problems = c.check({ before: ctx.store.get(), after: store.get(), reply: r.reply, steps: r.steps.map((s) => ({ tool: s.tool, args: s.args, ok: s.outcome.ok })) });
      expect(problems, `reply: ${r.reply}\nsteps: ${r.steps.map((s) => s.tool).join(', ')}`).toEqual([]);
      // the closing line is spoken: one short sentence, no ids or markdown
      expect(r.reply.length, r.reply).toBeLessThanOrEqual(200);
      expect(r.reply, 'no ids in the spoken reply').not.toMatch(/\b[tcd]\d+\b/);
      expect(r.reply).not.toMatch(/[*#`]|^\s*-\s/m);
      void agent;
    });
  }
});
