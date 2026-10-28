// The Muse agent loop: user message -> Muse (with tools) -> run tool calls -> feed results
// back -> repeat until Muse answers in text or MAX_STEPS is hit. The chat function is
// injected: live Meta API in the Electron main process, recorded fixtures in tests.
import { summarize } from './session';
import { chainLibrary } from '../fx/savedChains';
import { museToolSpecs, runTool, type ToolContext, type ToolOutcome } from './tools';

export const MAX_STEPS = 10;

export const SYSTEM_PROMPT = `You are Muse, the sound designer and session engineer inside Lattice, a small DAW.
You act only through the tools; every edit you make is a tool call on the session.
You cannot hear audio. Work from the session summary, tool results, sound metadata and measured numbers, never claim to have listened.
The user is the judge of how things sound: when you propose sounds, say what to listen for and let them pick.
The session header gives tempo (BPM), time signature, key and click state; change them with set_tempo, set_time_signature, set_key, set_metronome. Quantize follows the session tempo.
Times are in seconds, gain in dB. Track ids look like "t1", clip ids like "c2".
Each user turn starts with the current session and, if any, the edits the user made by hand since your last turn. Treat those hand edits as feedback on your earlier choices and build on them; don't undo them unless asked.
Tools marked stub return placeholder results for now; report them plainly.
Keep replies short: one or two sentences on what you did and what the user should do next.`;

// Minimal Chat Completions shapes (kept local so the renderer can import this file).
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}
export interface ChatRequest {
  messages: ChatMessage[];
  tools: ReturnType<typeof museToolSpecs>;
}
export interface ChatResponse {
  message: { content: string | null; tool_calls?: ToolCall[] };
  finish_reason: string;
  usage?: Usage;
}
export type ChatFn = (req: ChatRequest) => Promise<ChatResponse>;

export interface StepRecord {
  tool: string;
  args: unknown;
  outcome: ToolOutcome;
}
export interface TurnResult {
  reply: string;
  steps: StepRecord[];
  usage: Usage;
  stoppedEarly: boolean;
}

export function buildUserTurn(text: string, sessionSummary: string, userEdits: string[]): string {
  const edits = userEdits.length ? `\n<user_edits_since_last_turn>\n${userEdits.map((e) => `- ${e}`).join('\n')}\n</user_edits_since_last_turn>` : '';
  return `<session>\n${sessionSummary}\n</session>${edits}\n\n${text}`;
}

export class MuseAgent {
  readonly history: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];

  constructor(
    private ctx: ToolContext,
    private chat: ChatFn,
    private maxSteps = MAX_STEPS,
  ) {}

  async send(text: string): Promise<TurnResult> {
    const { store } = this.ctx;
    this.history.push({ role: 'user', content: buildUserTurn(text, summarize(store.get(), { savedChains: chainLibrary(this.ctx).list().map((c) => c.name) }), store.takeUserEdits()) });
    const steps: StepRecord[] = [];
    const usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };

    for (let step = 0; step < this.maxSteps; step++) {
      const res = await this.chat({ messages: this.history, tools: museToolSpecs() });
      usage.prompt_tokens += res.usage?.prompt_tokens ?? 0;
      usage.completion_tokens += res.usage?.completion_tokens ?? 0;
      const calls = res.message.tool_calls ?? [];
      this.history.push({ role: 'assistant', content: res.message.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });

      if (!calls.length) {
        const reply = res.message.content?.trim() || `(Muse returned no text; finish_reason ${res.finish_reason})`;
        return { reply, steps, usage, stoppedEarly: false };
      }
      for (const call of calls) {
        let args: unknown;
        let outcome: ToolOutcome;
        try {
          args = JSON.parse(call.function.arguments || '{}');
          outcome = await runTool(this.ctx, call.function.name, args, 'muse');
        } catch {
          args = call.function.arguments;
          outcome = { ok: false, error: 'arguments were not valid JSON' };
        }
        steps.push({ tool: call.function.name, args, outcome });
        this.history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome) });
      }
    }
    return { reply: `Stopped after ${this.maxSteps} steps without a final answer.`, steps, usage, stoppedEarly: true };
  }
}

/** Cost at contributor rates for muse-spark-1.3-contributor ($0.10 / $0.20 per M tokens). */
export function costUsd(u: Usage): number {
  return (u.prompt_tokens * 0.1 + u.completion_tokens * 0.2) / 1e6;
}
