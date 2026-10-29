// The audio clock, for things that must happen on the beat: the shared AudioContext, how long
// its output takes to reach the speakers, and waiting for an exact audio time.
import { getGlobalContext } from '@waveform-playlist/playout';

/** The playlist's AudioContext: clicks, recording and playback all run on its clock. */
export function audioContext(): AudioContext {
  return getGlobalContext().rawContext as unknown as AudioContext;
}

/** Run `fn` with the transport's scheduling lookahead set to `seconds`: the engine starts
 *  playback `lookAhead` after play() is called, so this starts it at an exact audio time.
 *  (Tone's Context.lookAhead is public; it is restored as soon as `fn` settles.) */
export async function withLookAhead<T>(seconds: number, fn: () => Promise<T>): Promise<T> {
  const tone = getGlobalContext();
  const was = tone.lookAhead;
  tone.lookAhead = seconds;
  try {
    return await fn();
  } finally {
    tone.lookAhead = was;
  }
}

/** Seconds from a sample leaving Web Audio to it reaching the speakers. */
export const outputDelay = (ctx: AudioContext) => (ctx.outputLatency || 0) + (ctx.baseLatency || 0);

/** Seconds from the mic to Web Audio, as far as the browser reports it. */
export function inputDelay(stream: MediaStream | null): number {
  const s = stream?.getAudioTracks()[0]?.getSettings() as { latency?: number } | undefined;
  return s?.latency || 0;
}

/** Resolves true once the audio clock reaches `t` (false if aborted first). A coarse timer gets
 *  close, then it polls every task turn, so it lands within one audio clock update of `t`. */
export function waitForAudioTime(ctx: AudioContext, t: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (ok: boolean) => {
      clearTimeout(timer);
      ch.port1.onmessage = null;
      ch.port1.close();
      signal.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = () => done(false);
    const check = () => {
      if (signal.aborted) return;
      const left = t - ctx.currentTime;
      if (left <= 0) done(true);
      else if (left > 0.015) timer = setTimeout(check, (left - 0.012) * 1000);
      else ch.port2.postMessage(0);
    };
    if (signal.aborted) return resolve(false);
    signal.addEventListener('abort', onAbort);
    ch.port1.onmessage = check;
    check();
  });
}

/** When the recorder starts the engine itself (sample-timed after a count-in), the play command
 *  it then sends only tells the session: TransportSync must not restart playback for it. */
let handedOff: number | null = null;
export const transportHandoff = {
  mark(position: number) {
    handedOff = position;
  },
  /** True (once) if this play command is the one the recorder already started. */
  take(position: number): boolean {
    const hit = handedOff !== null && Math.abs(handedOff - position) < 0.002;
    handedOff = null;
    return hit;
  },
};
