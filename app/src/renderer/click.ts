// The click track: Web Audio oscillator blips scheduled ahead on the audio clock by
// ClickScheduler (see core/metronome.ts). Shares the playlist's AudioContext so clicks and
// audio run on the same clock.
import { getGlobalContext } from '@waveform-playlist/playout';
import { barLength, ClickScheduler, countInClicks, type Meter } from '../core/metronome';

function audioContext(): AudioContext {
  return getGlobalContext().rawContext as unknown as AudioContext;
}

class ClickPlayer {
  private scheduled = new Set<OscillatorNode>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sched = new ClickScheduler((t, accent) => this.blip(t, accent), { tempo: 120, timeSignature: [4, 4] });

  private blip(time: number, accent: boolean) {
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
    this.scheduled.add(osc);
    osc.onended = () => this.scheduled.delete(osc);
  }

  /** Click along with the timeline: position `pos` is being emitted to the speakers now. */
  start(pos: number, meter: Meter) {
    this.stop();
    const ctx = audioContext();
    this.sched.start(ctx.currentTime, pos, meter);
    this.sched.tick(ctx.currentTime);
    this.timer = setInterval(() => this.sched.tick(ctx.currentTime), 25);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sched.stop();
    for (const o of this.scheduled) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
    }
    this.scheduled.clear();
  }

  /** One bar of clicks; resolves when the bar is over (i.e. on the next downbeat). */
  async countIn(meter: Meter): Promise<void> {
    const ctx = audioContext();
    if (ctx.state !== 'running') await ctx.resume();
    const t0 = ctx.currentTime + 0.05;
    for (const c of countInClicks(t0, meter)) this.blip(c.time, c.accent);
    const ms = (t0 + barLength(meter) - ctx.currentTime) * 1000;
    await new Promise((r) => setTimeout(r, ms));
  }
}

export const clicks = new ClickPlayer();
