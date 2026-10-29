// B2: Muse Voice Transcribe client (Node only: Electron main and the dev:web middleware).
// The key is read from the environment and never leaves this process.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { cleanTranscript, STT_MODEL, STT_URL, sttCostUsd, type Transcribe } from '../core/stt.ts';

/** One push-to-talk clip (16 kHz mono WAV) -> its transcript. Logs duration and cost per call. */
export async function metaTranscribe(
  wav: Uint8Array,
  opts: { apiKey?: string; usageLog?: string; fetch?: typeof fetch } = {},
): Promise<{ text: string; audioMs: number; usd: number }> {
  const apiKey = opts.apiKey ?? process.env.META_MODEL_API_KEY;
  if (!apiKey) throw new Error('META_MODEL_API_KEY is not set (add it to lattice/.env)');
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify({ model: STT_MODEL, mode: 'PUSH_TO_TALK', audioEncoding: 'WAV' })], { type: 'application/json' }));
  form.append('audio', new Blob([wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'clip.wav');
  const t0 = Date.now();
  const r = await (opts.fetch ?? fetch)(STT_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`transcription failed: HTTP ${r.status}${body?.error?.message ? ` ${body.error.message}` : ''}`);
  const audioMs = Number(body?.audioDurationMs ?? 0);
  const usd = sttCostUsd(audioMs);
  const entry = { at: new Date().toISOString(), model: STT_MODEL, audio_ms: audioMs, usd: Number(usd.toFixed(6)), ms: Date.now() - t0 };
  console.log(`[stt] ${JSON.stringify(entry)}`);
  if (opts.usageLog) {
    mkdirSync(dirname(opts.usageLog), { recursive: true });
    appendFileSync(opts.usageLog, JSON.stringify(entry) + '\n');
  }
  const text = cleanTranscript(String(body?.transcript ?? ''));
  if (!text) throw new Error('no speech heard in the clip');
  return { text, audioMs, usd };
}

/** The live transcriber, or fixed text with no network call under $LATTICE_STT_MOCK (tests). */
export function transcriberFromEnv(env: Record<string, string | undefined> = process.env, usageLog?: string): Transcribe {
  const mock = env.LATTICE_STT_MOCK;
  if (mock) return async () => ({ text: mock, audioMs: 0, usd: 0 });
  return (wav) => metaTranscribe(wav, { usageLog });
}
