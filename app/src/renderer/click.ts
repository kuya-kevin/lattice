// The click track: Web Audio oscillator blips scheduled ahead on the audio clock by
// ClickScheduler (see core/metronome.ts). Shares the playlist's AudioContext so clicks and
// audio run on the same clock. With a cycle, the click re-syncs at every wrap from the engine's
// own loopStart event (the engine's loop is a hair longer than the cycle, see ClickScheduler).
import { ClickScheduler, planCountIn, type Meter } from '../core/metronome';
import { getGlobalContext } from '@waveform-playlist/playout';
import { audioContext } from './audioClock';

class ClickPlayer {
  private scheduled = new Map<OscillatorNode, number>(); // -> its audio time
  private timer: ReturnType<typeof setInterval> | null = null;
  private offLoop: (() => void) | null = null;
  private sched = new ClickScheduler((t, accent) => this.blip(t, accent), { tempo: 120, timeSignature: [4, 4] });

  private blip(time: number, accent: boolean): OscillatorNode {
    const ctx = audioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1175;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
    this.scheduled.set(osc, time);
    osc.onended = () => this.scheduled.delete(osc);
    return osc;
  }

  /** Click along with the timeline: position `pos` is being emitted to the speakers now. With
   *  `cycle`, the transport loops over it. */
  start(pos: number, meter: Meter, cycle: { start: number; end: number } | null = null) {
    this.stop();
    const ctx = audioContext();
    this.sched.start(ctx.currentTime, pos, meter, cycle);
    this.sched.tick(ctx.currentTime);
    this.timer = setInterval(() => this.sched.tick(ctx.currentTime), 25);
    if (!cycle) return;
    // Tone's Transport emits loopStart ahead of time, with the wrap's exact audio time
    const transport = getGlobalContext().transport;
    const onLoop = (time: number, seconds: number) => {
      this.sched.wrap(time, seconds, ctx.currentTime);
      this.cancelFrom(time - 0.005); // anything counted on past the wrap
      this.sched.tick(ctx.currentTime);
    };
    transport.on('loopStart', onLoop);
    this.offLoop = () => transport.off('loopStart', onLoop);
  }

  private cancelFrom(time: number) {
    for (const [o, t] of this.scheduled) {
      if (t < time) continue;
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
      this.scheduled.delete(o);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.offLoop?.();
    this.offLoop = null;
    this.sched.stop();
    for (const o of this.scheduled.keys()) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
    }
    this.scheduled.clear();
  }

  /** Schedule a one-bar count-in on the bar grid before timeline `at` (the context must be
   *  running). `downbeat` is the audio time `at` must leave the transport; cancel() silences it. */
  countIn(at: number, meter: Meter): { downbeat: number; cancel: () => void } {
    const plan = planCountIn(at, meter, audioContext().currentTime);
    const oscs = plan.clicks.map((c) => this.blip(c.time, c.accent));
    const cancel = () => {
      for (const o of oscs) {
        try {
          o.stop();
        } catch {
          /* already stopped */
        }
      }
    };
    return { downbeat: plan.downbeat, cancel };
  }
}

export const clicks = new ClickPlayer();
