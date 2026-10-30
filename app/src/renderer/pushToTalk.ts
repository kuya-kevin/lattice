// B2 push-to-talk: capture the mic while ` (or the prompt bar's mic button) is held, and hand
// back a 16 kHz mono WAV for Muse Voice Transcribe. Its own mic stream, apart from the track
// recorder; echo cancellation keeps some of the speakers out.
import { encodeWavMono } from '../core/wav';
import { MAX_CLIP_S, STT_SAMPLE_RATE } from '../core/stt';

// While a track records (ControlBar sets this) the mic is busy: push-to-talk waits.
let recording = false;
const recordingListeners = new Set<(on: boolean) => void>();
export function setRecordingActive(on: boolean) {
  if (on === recording) return;
  recording = on;
  for (const l of recordingListeners) l(on); // B14: a recording cuts Muse's speech off
}
export function onRecordingChange(fn: (on: boolean) => void): () => void {
  recordingListeners.add(fn);
  return () => recordingListeners.delete(fn);
}
export const recordingActive = () => recording;

export interface Capture {
  /** 0..1, the mic's current level, for the meter */
  level(): number;
  /** stop and return the clip; seconds counts from when the mic opened */
  stop(): Promise<{ wav: ArrayBuffer; seconds: number }>;
  cancel(): void;
}

export async function startCapture(onTooLong: () => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const meterCtx = new AudioContext();
  const analyser = meterCtx.createAnalyser();
  analyser.fftSize = 512;
  meterCtx.createMediaStreamSource(stream).connect(analyser);
  const frame = new Float32Array(analyser.fftSize);
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const t0 = performance.now();
  recorder.start();
  const cap = setTimeout(onTooLong, MAX_CLIP_S * 1000);
  const close = () => {
    clearTimeout(cap);
    stream.getTracks().forEach((t) => t.stop());
    meterCtx.close().catch(() => {});
  };
  return {
    level() {
      analyser.getFloatTimeDomainData(frame);
      let e = 0;
      for (const x of frame) e += x * x;
      return Math.min(1, Math.sqrt(e / frame.length) * 4);
    },
    async stop() {
      const seconds = (performance.now() - t0) / 1000;
      const done = new Promise<void>((ok) => (recorder.onstop = () => ok()));
      recorder.stop();
      await done;
      close();
      const encoded = await new Blob(chunks).arrayBuffer();
      // decoding into a 16 kHz context resamples on the way
      const buf = await new OfflineAudioContext(1, 1, STT_SAMPLE_RATE).decodeAudioData(encoded);
      const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
      return { wav: encodeWavMono(chans, buf.sampleRate), seconds };
    },
    cancel() {
      if (recorder.state !== 'inactive') recorder.stop();
      close();
    },
  };
}
