// B2 push-to-talk: shared rules for spoken commands. The clip is transcribed by Muse Voice
// Transcribe (Meta, https://dev.meta.ai/docs/speech-to-text) in the main process; the text
// then goes to Muse as an ordinary chat turn.

export const STT_MODEL = 'muse-voice-transcribe-1.0';
export const STT_URL = 'https://api.meta.ai/v1/asr/transcribe';
/** the API takes 16 or 24 kHz mono 16-bit WAV */
export const STT_SAMPLE_RATE = 16000;
/** a shorter hold is an accidental tap; a longer one is cut off (the API allows 10 min) */
export const MIN_CLIP_S = 0.3;
export const MAX_CLIP_S = 30;

export type Transcribe = (wav: Uint8Array) => Promise<{ text: string; audioMs: number; usd: number }>;

export function clipLength(seconds: number): 'ok' | 'too short' | 'too long' {
  return seconds < MIN_CLIP_S ? 'too short' : seconds > MAX_CLIP_S ? 'too long' : 'ok';
}

/** $0.18 per hour of audio, billed per whole second (rounded down). */
export function sttCostUsd(audioMs: number): number {
  return (Math.floor(audioMs / 1000) * 0.18) / 3600;
}

/** Tidy spacing and a doubled full stop ("down 3 dB.." -> "down 3 dB."). */
export function cleanTranscript(text: string): string {
  return text.trim().replace(/\s+/g, ' ').replace(/\.{2,}$/, '.');
}
