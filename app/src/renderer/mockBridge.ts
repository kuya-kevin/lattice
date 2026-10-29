// In-page bridge for running the renderer as a plain web page (dev:web, Playwright).
// Same session store and tools as Electron; Muse is replaced by an offline stand-in
// because API keys must never reach a browser page.
import { MuseAgent, type ChatFn } from '../core/agent';
import type { Bridge } from '../core/bridge';
import type { PrepManifest } from '../core/midi';
import { StubSidecar, type CleanupNoiseResult, type DrumHitsResult, type ExtractMidiArgs, type QuantizeDrumsArgs, type QuantizeDrumsResult, type SoundRegionsResult } from '../core/sidecar';
import { SessionStore } from '../core/store';
import { runTool, type ToolContext } from '../core/tools';
import { MemoryChainLibrary } from '../fx/savedChains';
import { MemoryVersionLibrary } from '../core/versions';

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
  /** B3: processed audio by its new source id, for Bridge.loadSourceAudio */
  readonly processed = new Map<string, ArrayBuffer>();
  constructor(audio: Map<string, ArrayBuffer>) {
    super();
    this.audio = audio;
  }
  /** B3: cleanup/quantize through the Vite middleware (/api/sidecar/engineer). */
  private async engineer<R>(newSourceId: string, job: { op: string; sourceId: string } & Record<string, unknown>): Promise<R> {
    const wav = this.audio.get(job.sourceId);
    if (!wav) throw new Error(`no audio for source ${job.sourceId} yet`);
    const r = await fetch(`/api/sidecar/engineer?args=${encodeURIComponent(JSON.stringify(job))}`, { method: 'POST', body: wav });
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
    const result = JSON.parse(decodeURIComponent(r.headers.get('X-Lattice-Result') ?? '{}')) as R;
    this.processed.set(newSourceId, await r.arrayBuffer());
    return result;
  }
  override cleanupNoise(a: { sourceId: string; newSourceId: string }): Promise<CleanupNoiseResult> {
    return this.engineer(a.newSourceId, { op: 'cleanup', sourceId: a.sourceId });
  }
  override quantizeDrums({ newSourceId, ...a }: QuantizeDrumsArgs): Promise<QuantizeDrumsResult> {
    return this.engineer(newSourceId, { op: 'quantize', ...a });
  }
  /** B13: analyses (no audio back) through the Vite middleware (/api/sidecar/analyze) */
  private async analyze<R>(op: string, sourceId: string): Promise<R> {
    const wav = this.audio.get(sourceId);
    if (!wav) throw new Error(`no audio for source ${sourceId} yet`);
    const r = await fetch(`/api/sidecar/analyze?args=${encodeURIComponent(JSON.stringify({ op, sourceId }))}`, { method: 'POST', body: wav });
    const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    return body as R;
  }
  override drumHits(a: { sourceId: string }): Promise<DrumHitsResult> {
    return this.analyze('hits', a.sourceId);
  }
  override soundRegions(a: { sourceId: string }): Promise<SoundRegionsResult> {
    return this.analyze('regions', a.sourceId);
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
  const sidecar = new WebSidecar(sourceAudio);
  let measurer: Parameters<Bridge['serveMeasure']>[0] | null = null; // B9: set by the page (App)
  const ctx: ToolContext = {
    measureTrack: (s, trackId) => (measurer ? measurer(s, trackId) : Promise.reject(new Error('the page has not loaded yet'))),
    store,
    sidecar,
    searchFreesound: async () => ({ count: 0, results: [] }),
    chains: new MemoryChainLibrary(), // B10: kept for the page's lifetime only
    versions: new MemoryVersionLibrary(), // B11: same (no autosave in the browser build)
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
    // B11: audio buffers outlive any restore within the page, so only processed audio (B3) loads here
    keepSourceAudio: async () => {},
    loadSourceAudio: async (id) => sidecar.processed.get(id)?.slice(0) ?? null,
    serveMeasure: (fn) => void (measurer = fn),
    // B2: dev:web transcribes through the Vite middleware (/api/stt), which holds the key
    transcribe: async (wav) => {
      const r = await fetch('/api/stt', { method: 'POST', body: wav });
      const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
      return r.ok ? { ok: true, text: body.text } : { ok: false, error: body.error ?? `HTTP ${r.status}` };
    },
    sendChat: async (text) => {
      try {
        return { ok: true, turn: await agent.send(text) };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  };
}
