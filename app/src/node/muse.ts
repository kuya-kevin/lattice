// Live Meta Model API client (Node only: Electron main process and the fixture recorder).
// The key is read from the repo-root .env and never leaves this process.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from 'dotenv';
import OpenAI from 'openai';
import { costUsd, type ChatFn, type ChatResponse } from '../core/agent';

export const MODEL = 'muse-spark-1.3-contributor'; // $0.10 / $0.20 per M tokens (approved)
export const BASE_URL = 'https://api.meta.ai/v1';

export function loadEnv(envPath: string): void {
  config({ path: envPath, quiet: true });
}

/** Chat function backed by the live API. Logs model, tokens and cost per call (never the key). */
export function liveChat(opts: { usageLog?: string; reasoningEffort?: 'minimal' | 'low' | 'medium' } = {}): ChatFn {
  const apiKey = process.env.META_MODEL_API_KEY;
  if (!apiKey) throw new Error('META_MODEL_API_KEY is not set (add it to lattice/.env)');
  const client = new OpenAI({ baseURL: BASE_URL, apiKey });
  return async ({ messages, tools }) => {
    const t0 = Date.now();
    const r = await client.chat.completions.create({
      model: MODEL,
      // Reasoning shares this budget with the reply; small budgets come back empty.
      max_tokens: 16000,
      reasoning_effort: opts.reasoningEffort ?? 'low',
      messages: messages as any,
      tools,
    });
    const choice = r.choices[0];
    const usage = { prompt_tokens: r.usage?.prompt_tokens ?? 0, completion_tokens: r.usage?.completion_tokens ?? 0 };
    const entry = {
      at: new Date().toISOString(),
      model: MODEL,
      ...usage,
      reasoning_tokens: (r.usage as any)?.completion_tokens_details?.reasoning_tokens ?? null,
      usd: Number(costUsd(usage).toFixed(6)),
      ms: Date.now() - t0,
      finish_reason: choice.finish_reason,
      tool_calls: choice.message.tool_calls?.map((c: any) => c.function.name) ?? [],
    };
    console.log(`[muse] ${JSON.stringify(entry)}`);
    if (opts.usageLog) {
      mkdirSync(dirname(opts.usageLog), { recursive: true });
      appendFileSync(opts.usageLog, JSON.stringify(entry) + '\n');
    }
    const out: ChatResponse = {
      message: {
        content: choice.message.content,
        ...(choice.message.tool_calls?.length
          ? { tool_calls: choice.message.tool_calls.map((c: any) => ({ id: c.id, type: 'function' as const, function: { name: c.function.name, arguments: c.function.arguments } })) }
          : {}),
      },
      finish_reason: choice.finish_reason,
      usage,
    };
    return out;
  };
}
