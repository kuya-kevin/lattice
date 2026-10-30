// B14: the voices Muse's replies are spoken with. Electron uses Meta's MMS-TTS English in a Web
// Worker (tts.worker.ts); the web build and Playwright use a silent mock that only takes time, so
// tests never download the model. The web build uses the real one too, except under automation
// (Playwright sets navigator.webdriver); `?voice=mock` / `?voice=mms` force either.
import type { TtsDevice, TtsReply, TtsRequest } from './tts.worker';

export interface Speech {
  /** resolves when the speech ends or is stopped (never rejects) */
  done: Promise<void>;
  stop(): void;
}

/** Whether the voice can speak yet: the model downloads on first use (~115 MB), then is cached. */
export interface VoiceStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  /** download progress, 0-100, while loading */
  progress?: number;
  error?: string;
}

export interface Voice {
  kind: 'mms' | 'mock';
  speak(text: string): Speech;
  /** start loading the model (the first reply would wait for it otherwise) */
  warm?(): void;
  status(): VoiceStatus;
  onStatus(fn: (s: VoiceStatus) => void): () => void;
}

/** Keeps a voice's status and tells listeners when it changes. */
class StatusBox {
  private listeners = new Set<(s: VoiceStatus) => void>();
  constructor(public value: VoiceStatus) {}
  set(s: VoiceStatus) {
    this.value = s;
    for (const l of this.listeners) l(s);
  }
  on(fn: (s: VoiceStatus) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}

/** Silent stand-in: "speaks" for msPerChar per character (at least 300 ms). */
export class MockVoice implements Voice {
  readonly kind = 'mock';
  msPerChar = 20;
  /** tests set this to show a loading or failed model */
  readonly box = new StatusBox({ state: 'ready' });
  status = () => this.box.value;
  onStatus = (fn: (s: VoiceStatus) => void) => this.box.on(fn);
  speak(text: string): Speech {
    let stop = () => {};
    const done = new Promise<void>((ok) => {
      const t = setTimeout(ok, Math.max(300, text.length * this.msPerChar));
      stop = () => {
        clearTimeout(t);
        ok();
      };
    });
    return { done, stop: () => stop() };
  }
}

/** Meta's MMS-TTS English (VITS, fp32) in a worker; plays on its own AudioContext so it is
 *  unaffected by the transport. */
export class MmsVoice implements Voice {
  readonly kind = 'mms';
  private worker: Worker | null = null;
  private ctx: AudioContext | null = null;
  private next = 1;
  private waiting = new Map<number, (r: TtsReply) => void>();
  private box = new StatusBox({ state: 'idle' });
  status = () => this.box.value;
  onStatus = (fn: (s: VoiceStatus) => void) => this.box.on(fn);

  constructor(readonly device: TtsDevice = ttsDevice()) {}

  private loaded(r: TtsReply) {
    if ('error' in r) this.box.set({ state: 'error', error: r.error });
    else if (this.box.value.state !== 'ready') this.box.set({ state: 'ready' });
  }

  private call(req: { text: string } | { warm: true }): Promise<TtsReply> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<TtsReply>) => {
        if ('progress' in e.data) return this.box.set({ state: 'loading', progress: e.data.progress });
        this.loaded(e.data);
        this.waiting.get(e.data.id)?.(e.data);
        this.waiting.delete(e.data.id);
      };
    }
    const id = this.next++;
    if (this.box.value.state === 'idle' || this.box.value.state === 'error') this.box.set({ state: 'loading', progress: 0 });
    return new Promise((ok) => {
      this.waiting.set(id, ok);
      this.worker!.postMessage({ id, device: this.device, ...req } satisfies TtsRequest);
    });
  }

  warm() {
    void this.call({ warm: true }).then((r) => {
      if ('error' in r) console.warn('[voice] MMS-TTS failed to load:', r.error);
      else if ('loaded' in r) console.info(`[voice] MMS-TTS loaded in ${r.ms} ms (${this.device})`);
    });
  }

  speak(text: string): Speech {
    let stopped = false;
    let src: AudioBufferSourceNode | null = null;
    let finish = () => {};
    const done = new Promise<void>((ok) => (finish = ok));
    const stop = () => {
      stopped = true;
      try {
        src?.stop();
      } catch {
        // not started yet
      }
      finish();
    };
    void this.call({ text }).then(async (r) => {
      if (stopped) return;
      if (!('audio' in r)) {
        console.warn('[voice] MMS-TTS:', 'error' in r ? r.error : r);
        return finish();
      }
      console.info(`[voice] MMS-TTS ${r.ms} ms for ${(r.audio.length / r.rate).toFixed(2)} s: "${text}"`);
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
      const buf = this.ctx.createBuffer(1, r.audio.length, r.rate);
      buf.copyToChannel(r.audio as Float32Array<ArrayBuffer>, 0);
      src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.onended = () => finish();
      if (!stopped) src.start();
    });
    return { done, stop };
  }
}

/** Where the model runs: localStorage 'lattice.ttsDevice' = 'wasm' | 'webgpu' overrides 'auto'. */
function ttsDevice(): TtsDevice {
  try {
    const d = localStorage.getItem('lattice.ttsDevice');
    return d === 'wasm' || d === 'webgpu' ? d : 'auto';
  } catch {
    return 'auto';
  }
}

export function pickVoice(mode: 'electron' | 'web', search = location.search, automated = navigator.webdriver): Voice {
  if (mode === 'electron') return new MmsVoice();
  const asked = new URLSearchParams(search).get('voice');
  return asked === 'mms' || (asked !== 'mock' && !automated) ? new MmsVoice() : new MockVoice();
}
