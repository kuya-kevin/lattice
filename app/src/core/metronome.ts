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

/** How early the scheduler wraps a cycle by itself when the engine hasn't said it wrapped (the
 *  engine says so ~50-100 ms ahead; this keeps the downbeat click from being missed). */
const WRAP_FALLBACK = 0.02;

/** With a cycle, the engine's loop is not exactly the cycle's length: Tone's Transport wraps on
 *  its next tick (1/384 s at its own 120 BPM), so each pass runs up to 2.6 ms long. Counting
 *  beats straight on drifts that much per pass (Oct 30: 0.8 ms a pass, 30 ms after 39 passes),
 *  so the scheduler stops at the cycle end and carries on from where the engine says it wrapped
 *  (wrap()). */
export class ClickScheduler {
  private anchorAudio = 0; // audio-clock time at which timeline position anchorPos is heard
  private anchorPos = 0;
  private nextBeat = 0; // index of the next beat to schedule (beat 0 = timeline 0)
  private running = false;
  private cycle: { start: number; end: number } | null = null;

  constructor(
    private sink: ClickSink,
    private meter: Meter,
    readonly lookahead = 0.1,
  ) {}

  /** Start clicking: timeline position `pos` is heard at audio time `audioTime`. With `cycle`,
   *  the transport loops over it (from inside it). */
  start(audioTime: number, pos: number, meter: Meter = this.meter, cycle: { start: number; end: number } | null = null): void {
    this.meter = meter;
    this.cycle = cycle && cycle.end > cycle.start ? cycle : null;
    this.anchor(audioTime, pos);
    this.running = true;
  }

  /** The transport wrapped: timeline `pos` (the cycle start) is heard at `audioTime`. Clicks
   *  already handed over before `audioTime` stand; the caller cancels any after it. */
  wrap(audioTime: number, pos: number, audioNow = audioTime): void {
    if (!this.running) return;
    const passEnd = this.anchorPos + audioTime - this.anchorAudio;
    this.emit(Math.min(passEnd, this.cycle?.end ?? passEnd) - 1e-6, audioNow); // the rest of the pass
    this.anchor(audioTime, pos);
  }

  private anchor(audioTime: number, pos: number) {
    this.anchorAudio = audioTime;
    this.anchorPos = pos;
    this.nextBeat = Math.max(0, Math.ceil(pos / beatLength(this.meter) - 1e-6)); // first beat at or after pos
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
    const c = this.cycle && this.anchorPos < this.cycle.end - 1e-6 ? this.cycle : null; // looping
    if (!c) return this.emit(this.anchorPos + (audioNow + this.lookahead - this.anchorAudio), audioNow);
    // no word from the engine and the cycle end is close: wrap on the nominal time
    const end = this.anchorAudio + c.end - this.anchorPos;
    let n = 0;
    if (audioNow + WRAP_FALLBACK >= end) {
      n += this.emit(c.end - 1e-6, audioNow);
      this.anchor(end, c.start);
    }
    // never past the cycle end: the engine says when it wraps
    return n + this.emit(Math.min(this.anchorPos + (audioNow + this.lookahead - this.anchorAudio), c.end - 1e-6), audioNow);
  }

  /** Hand over every beat before timeline `horizonPos` (in this pass). */
  private emit(horizonPos: number, audioNow: number): number {
    const beat = beatLength(this.meter);
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

/** A one-bar count-in before a take starting at timeline `at`: the clicks fall on the bar grid
 *  (the beats of the bar leading up to `at`, bar downbeats accented), so the transport's click
 *  carries straight on after it. The first click sounds `lead` seconds after audio time `now`;
 *  `downbeat` is the audio time at which `at` must leave the transport. */
export interface CountInPlan {
  downbeat: number;
  clicks: { time: number; accent: boolean }[];
}

export function planCountIn(at: number, m: Meter, now: number, lead = 0.05): CountInPlan {
  const beat = beatLength(m);
  const n = m.timeSignature[0];
  const first = Math.ceil((at - barLength(m)) / beat - 1e-6); // first grid beat in [at - bar, at)
  const t0 = now + lead;
  return {
    downbeat: t0 + (at - first * beat),
    clicks: Array.from({ length: n }, (_, i) => ({ time: t0 + i * beat, accent: (((first + i) % n) + n) % n === 0 })),
  };
}

/** The bar line before `pos` (a whole bar back from one), not before 0: the , key. */
export function prevBarLine(pos: number, m: Meter): number {
  const bar = barLength(m);
  return Math.max(0, (Math.ceil(pos / bar - 1e-6) - 1) * bar);
}

/** The bar line after `pos` (a whole bar on from one): the . key. */
export function nextBarLine(pos: number, m: Meter): number {
  const bar = barLength(m);
  return (Math.floor(pos / bar + 1e-6) + 1) * bar;
}
