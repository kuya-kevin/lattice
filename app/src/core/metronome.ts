// Click track timing (pure, no Web Audio here so it's unit-testable).
// Lookahead scheduling (the "tale of two clocks" pattern): a coarse JS timer calls tick()
// every ~25 ms, and tick() hands every click falling in the next `lookahead` seconds to the
// audio clock with an exact AudioContext time, so clicks stay sample-accurate even when the
// JS timer jitters.

export interface Meter {
  tempo: number; // BPM (quarter notes)
  timeSignature: [number, number];
}

export const beatLength = (m: Meter) => (60 / m.tempo) * (4 / m.timeSignature[1]);
export const barLength = (m: Meter) => beatLength(m) * m.timeSignature[0];

/** Timeline seconds -> 1-based bar, beat and sixteenth-of-beat ("division"), Logic-style. */
export function toBarsBeats(seconds: number, m: Meter): { bar: number; beat: number; division: number } {
  const beat = beatLength(m);
  const beats = Math.max(0, seconds) / beat + 1e-9;
  const whole = Math.floor(beats);
  return {
    bar: Math.floor(whole / m.timeSignature[0]) + 1,
    beat: (whole % m.timeSignature[0]) + 1,
    division: Math.floor((beats - whole) * 4) + 1,
  };
}

export function formatBarsBeats(seconds: number, m: Meter): string {
  const { bar, beat, division } = toBarsBeats(seconds, m);
  return `${bar} ${beat} ${division}`;
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const min = Math.floor(s / 60);
  return `${min}:${(s - min * 60).toFixed(2).padStart(5, '0')}`;
}

export type ClickSink = (audioTime: number, accent: boolean) => void;

export class ClickScheduler {
  private anchorAudio = 0; // audio-clock time at which timeline position anchorPos is heard
  private anchorPos = 0;
  private nextBeat = 0; // index of the next beat to schedule (beat 0 = timeline 0)
  private running = false;

  constructor(
    private sink: ClickSink,
    private meter: Meter,
    readonly lookahead = 0.1,
  ) {}

  /** Start clicking: timeline position `pos` is heard at audio time `audioTime`. */
  start(audioTime: number, pos: number, meter: Meter = this.meter): void {
    this.meter = meter;
    this.anchorAudio = audioTime;
    this.anchorPos = pos;
    this.nextBeat = Math.max(0, Math.ceil(pos / beatLength(meter) - 1e-6)); // first beat at or after pos
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Schedule every click up to audioNow + lookahead. Returns how many were scheduled. */
  tick(audioNow: number): number {
    if (!this.running) return 0;
    const beat = beatLength(this.meter);
    const horizonPos = this.anchorPos + (audioNow + this.lookahead - this.anchorAudio);
    let n = 0;
    while (this.nextBeat * beat < horizonPos) {
      const t = this.anchorAudio + this.nextBeat * beat - this.anchorPos;
      if (t >= audioNow - 0.005) this.sink(t, this.nextBeat % this.meter.timeSignature[0] === 0); // skip clicks already in the past
      this.nextBeat++;
      n++;
    }
    return n;
  }
}

/** Audio times of a one-bar count-in starting at `audioTime` (downbeat accented). */
export function countInClicks(audioTime: number, m: Meter): { time: number; accent: boolean }[] {
  return Array.from({ length: m.timeSignature[0] }, (_, i) => ({ time: audioTime + i * beatLength(m), accent: i === 0 }));
}
