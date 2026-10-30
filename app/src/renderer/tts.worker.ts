// B14: Meta's MMS-TTS English (facebook/mms-tts-eng, VITS) in a Web Worker, so synthesis never
// blocks the page or its audio. ONNX build Xenova/mms-tts-eng through the Transformers.js
// text-to-speech pipeline, fp32 (int8 is reported to hurt VITS audio). The weights (~115 MB,
// CC BY-NC 4.0) download from the Hugging Face Hub on first use into the browser cache.
import { pipeline } from '@huggingface/transformers';

export const TTS_MODEL = 'Xenova/mms-tts-eng';

/** auto: WebGPU where the GPU is there (about 0.2 s per short phrase in Electron on an M-series
 *  Mac, after a ~1.5 s first call), else WASM (about real time: ~2 s for a 2 s phrase) */
export type TtsDevice = 'auto' | 'wasm' | 'webgpu';
export type TtsRequest = ({ id: number; text: string } | { id: number; warm: true }) & { device: TtsDevice };
export type TtsReply =
  | { id: number; audio: Float32Array; rate: number; ms: number }
  | { id: 0; progress: number } // model download, 0-100 (first use only; cached after)
  | { id: number; loaded: true; ms: number }
  | { id: number; error: string };

let lastPct = -1;
const loadOn = (device: 'wasm' | 'webgpu') =>
  pipeline('text-to-speech', TTS_MODEL, {
    dtype: 'fp32',
    device,
    progress_callback: (p) => {
      if (p.status !== 'progress_total') return;
      const pct = Math.floor(p.progress);
      if (pct !== lastPct) post({ id: 0, progress: (lastPct = pct) });
    },
  });
async function loadPipeline(device: TtsDevice) {
  const gpu = device === 'webgpu' || (device === 'auto' && 'gpu' in navigator);
  if (!gpu) return loadOn('wasm');
  try {
    return await loadOn('webgpu');
  } catch (e) {
    console.warn('[voice] MMS-TTS on WebGPU failed, using WASM:', e);
    return loadOn('wasm');
  }
}
let synth: ReturnType<typeof loadPipeline> | null = null;
let loadMs = 0;
function load(device: TtsDevice) {
  if (!synth) {
    const t0 = performance.now();
    synth = loadPipeline(device).then((p) => {
      loadMs = Math.round(performance.now() - t0);
      return p;
    });
    synth.catch(() => (synth = null)); // a failed download can be tried again
  }
  return synth;
}

const post = (r: TtsReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(r, transfer);

self.onmessage = async (e: MessageEvent<TtsRequest>) => {
  const req = e.data;
  try {
    const p = await load(req.device);
    if ('warm' in req) return post({ id: req.id, loaded: true, ms: loadMs });
    const t0 = performance.now();
    const out = await p(req.text);
    const audio = out.audio as Float32Array;
    post({ id: req.id, audio, rate: out.sampling_rate, ms: Math.round(performance.now() - t0) }, [audio.buffer]);
  } catch (err) {
    post({ id: req.id, error: err instanceof Error ? err.message : String(err) });
  }
};
