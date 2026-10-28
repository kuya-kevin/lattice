// In-page bridge for running the renderer as a plain web page (dev:web, Playwright).
// Same session store and tools as Electron; Muse is replaced by an offline stand-in
// because API keys must never reach a browser page.
import { MuseAgent, type ChatFn } from '../core/agent';
import type { Bridge } from '../core/bridge';
import type { PrepManifest } from '../core/midi';
import { StubSidecar, type ExtractMidiArgs } from '../core/sidecar';
import { SessionStore } from '../core/store';
import { runTool, type ToolContext } from '../core/tools';
import { MemoryChainLibrary } from '../fx/savedChains';

/** Offline stand-in: lists the tracks once, then answers with what it saw. */
const offlineMuse: ChatFn = async ({ messages }) => {
  const last = messages[messages.length - 1];
  if (last.role === 'tool') {
    const summary = (JSON.parse(last.content).result?.summary as string) ?? '';
    return { message: { content: `(offline mock, no Muse in the browser build) Session:\n${summary}` }, finish_reason: 'stop' };
  }
  return { message: { content: null, tool_calls: [{ id: `mock-${messages.length}`, type: 'function', function: { name: 'list_tracks', arguments: '{}' } }] }, finish_reason: 'tool_calls' };
};

/** [S3 midi] dev:web: extract_midi goes to the Vite middleware (/api/sidecar/extract-midi),
 *  which runs the Python sidecar (or returns a fixture manifest under $LATTICE_SIDECAR_MOCK). */
class WebSidecar extends StubSidecar {
  private audio: Map<string, ArrayBuffer>;
  constructor(audio: Map<string, ArrayBuffer>) {
    super();
    this.audio = audio;
  }
  override async extractMidi(a: ExtractMidiArgs): Promise<PrepManifest> {
    const wav = this.audio.get(a.sourceId);
    if (!wav) throw new Error(`no audio for source ${a.sourceId} yet`);
    const r = await fetch(`/api/sidecar/extract-midi?args=${encodeURIComponent(JSON.stringify(a))}`, { method: 'POST', body: wav });
    const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    return body as PrepManifest;
  }
}

export function createMockBridge(): Bridge {
  const store = new SessionStore();
  const sourceAudio = new Map<string, ArrayBuffer>(); // [S3 midi]
  const ctx: ToolContext = {
    store,
    sidecar: new WebSidecar(sourceAudio),
    searchFreesound: async () => ({ count: 0, results: [] }),
    chains: new MemoryChainLibrary(), // B10: kept for the page's lifetime only
  };
  const agent = new MuseAgent(ctx, offlineMuse);
  return {
    mode: 'web',
    getSession: async () => store.get(),
    onSession: (cb) => store.subscribe(cb),
    runTool: (name, args) => runTool(ctx, name, args, 'user'),
    // dev:web: served by the Vite middleware in vite.config.ts (fixtures in tests)
    listLibrary: async () => {
      const r = await fetch('/api/library');
      return r.ok ? r.json() : [];
    },
    loadLibraryAudio: async (id) => {
      const r = await fetch(`/api/library/audio/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`library audio ${id}: HTTP ${r.status}`);
      return r.arrayBuffer();
    },
    putSourceAudio: async (id, wav) => void sourceAudio.set(id, wav), // [S3 midi]
    sendChat: async (text) => {
      try {
        return { ok: true, turn: await agent.send(text) };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  };
}
