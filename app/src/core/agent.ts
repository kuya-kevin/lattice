// The Muse agent loop: user message -> Muse (with tools) -> run tool calls -> feed results
// back -> repeat until Muse answers in text or MAX_STEPS is hit. The chat function is
// injected: live Meta API in the Electron main process, recorded fixtures in tests.
import { museSummary, museToolSpecs, runTool, type ToolContext, type ToolOutcome } from './tools';
import { autoVersion } from './versions';

export const MAX_STEPS = 10;

export const SYSTEM_PROMPT = `You are Muse, the session engineer inside Lattice, a small DAW. The producer tells you what to do; you do it through the tools. Every edit is a tool call on the session.
You cannot hear audio. Work from the session summary, tool results and measured numbers; never claim to have listened.
Act on concrete instructions: arrange (move, copy, repeat, split, delete or insert bars), mix (gain, pan, mute, solo), tracks (new, duplicate, rename, colour), edits (quantize, transpose, trim, fade) and devices (add, remove, set a knob). Do what was asked, to what was named, and nothing more.
Find the target in the session summary: "this", "it" or "that" is the selection (last line); names ("the vocal", "the double", "the blue track") match track names, clip names or colours; positions ("bar 9", "bars 5-8") are 1-based bars, as the summary shows them. Tools take ids; "bars 5-8" is from_bar 5, to_bar 8. If two things fit equally, ask which one.
If the request is only a sound word ("better", "more open", "wider", "brighter", "punchier"), don't guess: ask one short question offering one or two concrete changes, e.g. "Brighter how: raise the top-end EQ, or cut the low-mids?" Do it once the user picks.
Building a sample pad is concrete too, even with a mood word: for "make me a dusty lo-fi kit", call find_library_sounds for each drum category (kick, snare, closed_hat, open_hat, clap, percussion; noise_vinyl for dust) in one step, then one fill_kit, choosing by names, tags and descriptions. Say which sounds you picked.
When the user names a value ("-50 dB", "30% left", "up an octave"), use exactly that; on set_param and insert_device pass exact: true.
The session header gives tempo (BPM), time signature, key and click; change them with set_tempo, set_time_signature, set_key, set_metronome. set_cycle loops a bar range ("set up a two-bar loop"); play then starts at the cycle. detect_key reads a clip's key from its notes (set_session_key to adopt it). Quantize follows the session tempo.
Times are in seconds, gain in dB, pan -1 (left) to 1 (right). Track ids look like "t1", clip ids like "c2".
find_sound measures where a clip has sound (dead space, silent gaps). Use it for requests about where sound starts or stops, like trimming silence; don't ask the user for times you can measure.
Each user turn starts with the current session and, if any, the edits the user made by hand since your last turn. Build on those edits; don't undo them unless asked.
Tools marked stub return placeholder results for now; say so plainly.
End every turn with one short, plain sentence saying what you did, or your one question. It is read aloud: use track names, not ids, and no lists or markdown. Example: "Moved the vocal to bar 9 and turned it down 3 dB."`;

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
    autoVersion(this.ctx, `Before Muse: "${shorten(text)}"`); // B11: so "go back to before X" works
    try {
      return await this.turn(text);
    } finally {
      // so the Versions log keeps the user's hand edits after this turn apart from Muse's own
      autoVersion(this.ctx, `After Muse: "${shorten(text)}"`);
    }
  }

  private async turn(text: string): Promise<TurnResult> {
    const { store } = this.ctx;
    this.history.push({ role: 'user', content: buildUserTurn(text, museSummary(this.ctx), store.takeUserEdits()) });
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

/** A request cut to about 36 characters at a word boundary, for an auto version's name. */
function shorten(text: string, max = 36): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : max)}…`;
}
