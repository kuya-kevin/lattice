// In-page bridge for running the renderer as a plain web page (dev:web, Playwright).
// Same session store and tools as Electron; Muse is replaced by an offline stand-in
// because API keys must never reach a browser page.
import { MuseAgent, type ChatFn } from '../core/agent';
import type { Bridge } from '../core/bridge';
import { StubSidecar } from '../core/sidecar';
import { SessionStore } from '../core/store';
import { runTool, type ToolContext } from '../core/tools';

/** Offline stand-in: lists the tracks once, then answers with what it saw. */
const offlineMuse: ChatFn = async ({ messages }) => {
  const last = messages[messages.length - 1];
  if (last.role === 'tool') {
    const summary = (JSON.parse(last.content).result?.summary as string) ?? '';
    return { message: { content: `(offline mock, no Muse in the browser build) Session:\n${summary}` }, finish_reason: 'stop' };
  }
  return { message: { content: null, tool_calls: [{ id: `mock-${messages.length}`, type: 'function', function: { name: 'list_tracks', arguments: '{}' } }] }, finish_reason: 'tool_calls' };
};

export function createMockBridge(): Bridge {
  const store = new SessionStore();
  const ctx: ToolContext = {
    store,
    sidecar: new StubSidecar(),
    searchFreesound: async () => ({ count: 0, results: [] }),
  };
  const agent = new MuseAgent(ctx, offlineMuse);
  return {
    mode: 'web',
    getSession: async () => store.get(),
    onSession: (cb) => store.subscribe(cb),
    runTool: (name, args) => runTool(ctx, name, args, 'user'),
    sendChat: async (text) => {
      try {
        return { ok: true, turn: await agent.send(text) };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  };
}
