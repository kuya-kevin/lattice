// Records live Muse exchanges to tests/fixtures/<scenario>.json (costs real tokens).
// Usage: npm run record-fixtures -- [scenario ...]   (default: all scenarios)
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costUsd, type ChatFn, type ChatResponse } from '../src/core/agent';
import { searchFreesound } from '../src/core/freesound';
import { SCENARIOS, freesoundKey, runScenario, type Fixture } from '../src/core/scenario';
import { liveChat, loadEnv, MODEL } from '../src/node/muse';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(appDir, '..', '.env'));
const wanted = process.argv.slice(2);
const live = liveChat({ usageLog: resolve(appDir, 'logs', 'muse-usage.jsonl') });
const fsToken = process.env.FREESOUND_API_KEY;
if (!fsToken) throw new Error('FREESOUND_API_KEY is not set');

let total = { prompt_tokens: 0, completion_tokens: 0 };
for (const sc of SCENARIOS.filter((s) => !wanted.length || wanted.includes(s.name))) {
  const responses: ChatResponse[] = [];
  const freesound: Fixture['freesound'] = {};
  const chat: ChatFn = async (req) => {
    const r = await live(req);
    responses.push(r);
    return r;
  };
  const { results } = await runScenario(sc, chat, async (q, f, n) => {
    const r = await searchFreesound(fsToken, q, f, n);
    freesound[freesoundKey(q, f, n)] = r;
    return r;
  });
  const usage = results.reduce(
    (u, r) => ({ prompt_tokens: u.prompt_tokens + r.usage.prompt_tokens, completion_tokens: u.completion_tokens + r.usage.completion_tokens }),
    { prompt_tokens: 0, completion_tokens: 0 },
  );
  total = { prompt_tokens: total.prompt_tokens + usage.prompt_tokens, completion_tokens: total.completion_tokens + usage.completion_tokens };
  const fixture: Fixture = { ...sc, model: MODEL, recordedAt: new Date().toISOString(), responses, freesound, usage };
  const out = resolve(appDir, 'tests', 'fixtures', `${sc.name}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
  for (const r of results) {
    console.log(`\n[${sc.name}] tools: ${r.steps.map((s) => `${s.tool}${s.outcome.ok ? '' : ' (error)'}`).join(', ') || 'none'}`);
    console.log(`[${sc.name}] reply: ${r.reply}`);
  }
  console.log(`[${sc.name}] ${responses.length} calls, ${usage.prompt_tokens} in / ${usage.completion_tokens} out, $${costUsd(usage).toFixed(5)} -> ${out}`);
}
console.log(`\nTOTAL ${total.prompt_tokens} in / ${total.completion_tokens} out, $${costUsd(total).toFixed(5)}`);
