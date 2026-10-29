// B9 "ears": measured features of a rendered track, as numbers Muse can read (it cannot hear).
// Pure functions on sample arrays (no DOM), so they are tested in Vitest on synthetic signals;
// the renderer renders the track (fx/engine/render.ts) and calls measure().
//
// What each feature tracks, for the sound words Muse handles:
//   level/peak        louder, quieter, clipping
//   crest             how far transients stand out over the level (10 ms peak): punch, squashed
//   spread            loud-to-quiet range of 400 ms windows: even, compressed
//   brightness        spectral centroid: bright, dull, dark, warm
//   bands             level per band: muddy (low-mid), boomy (low), harsh (presence),
//                     sibilant (sibilance), airy (air), telephone (everything outside 300-3400 Hz)
//   width             side/mid ratio: wide, mono

export interface Features {
  seconds: number;
  /** RMS of the audible part (windows within 50 dB of the loudest), dBFS */
  level_db: number;
  /** sample peak, dBFS (clipping) */
  peak_db: number;
  /** loudest 10 ms window minus level: how far the transients stand out (punch). 10 ms, not the
   *  sample peak, so single-sample spikes don't count. A compressor can raise it (a slow attack
   *  lets hits through while the body comes down) while it lowers spread. */
  crest_db: number;
  /** loud (95th pct) minus quiet (10th pct) 400 ms window level, audible part only */
  spread_db: number;
  /** spectral centroid of the mid signal, Hz */
  brightness_hz: number;
  /** level per band, dBFS */
  bands: Record<Band, number>;
  /** side RMS / mid RMS: 0 = mono, about 1 = uncorrelated channels */
  width: number;
  silent?: true;
}

export const BANDS = [
  ['sub', 20, 60],
  ['low', 60, 250],
  ['low_mid', 250, 500],
  ['mid', 500, 2000],
  ['presence', 2000, 5000],
  ['sibilance', 5000, 10000],
  ['air', 10000, 20000],
] as const;
export type Band = (typeof BANDS)[number][0];

const N = 4096;
const db = (p: number) => (p > 1e-12 ? 10 * Math.log10(p) : -120);
const r1 = (x: number) => Math.round(x * 10) / 10;

/** In-place radix-2 FFT (re, im of length N, a power of two). */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
  }
}

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

/** Features of a mono or stereo signal. Only `maxSeconds` from the start are analysed. */
export function measure(channels: Float32Array[], sampleRate: number, maxSeconds = 60): Features {
  const len = Math.min(channels[0]?.length ?? 0, Math.round(maxSeconds * sampleRate));
  const L = channels[0] ?? new Float32Array(0);
  const R = channels[1] ?? L;
  const mid = new Float32Array(len);
  const side = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    mid[i] = (L[i] + R[i]) / 2;
    side[i] = (L[i] - R[i]) / 2;
  }

  // 400 ms windows: which part is audible, and the loud-to-quiet spread
  const win = Math.max(1, Math.round(0.4 * sampleRate));
  const winDb: number[] = [];
  for (let i = 0; i + win <= len; i += win) {
    let e = 0;
    for (let j = i; j < i + win; j++) e += (L[j] * L[j] + R[j] * R[j]) / 2;
    winDb.push(db(e / win));
  }
  const loudest = winDb.length ? Math.max(...winDb) : -120;
  const empty = { sub: -120, low: -120, low_mid: -120, mid: -120, presence: -120, sibilance: -120, air: -120 };
  if (loudest < -100) return { seconds: r1(len / sampleRate), level_db: -120, peak_db: -120, crest_db: 0, spread_db: 0, brightness_hz: 0, bands: empty, width: 0, silent: true };
  const audible = winDb.map((d) => d > loudest - 50);

  let e = 0, n = 0, peak = 0, em = 0, es = 0;
  for (let w = 0; w < winDb.length; w++) {
    if (!audible[w]) continue;
    for (let j = w * win; j < (w + 1) * win; j++) {
      e += (L[j] * L[j] + R[j] * R[j]) / 2;
      em += mid[j] * mid[j];
      es += side[j] * side[j];
      n++;
    }
  }
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const level = db(e / n);
  const short = Math.max(1, Math.round(0.01 * sampleRate));
  let shortPeak = 0;
  for (let i = 0; i + short <= len; i += short) {
    let es10 = 0;
    for (let j = i; j < i + short; j++) es10 += (L[j] * L[j] + R[j] * R[j]) / 2;
    shortPeak = Math.max(shortPeak, es10 / short);
  }
  const loud = winDb.filter((_, w) => audible[w]);

  // averaged power spectrum of the mid signal over audible frames (Hann, 50% overlap)
  const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const wNorm = hann.reduce((a, h) => a + h * h, 0);
  const power = new Float64Array(N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  let frames = 0;
  for (let i = 0; i + N <= len; i += N / 2) {
    if (!audible[Math.min(winDb.length - 1, Math.floor((i + N / 2) / win))]) continue;
    for (let k = 0; k < N; k++) {
      re[k] = mid[i + k] * hann[k];
      im[k] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  const hz = (k: number) => (k * sampleRate) / N;
  // scale so a band's value is the mean-square level its frequencies contribute (Parseval)
  const scale = frames ? 2 / (frames * wNorm * N) : 0;
  const bands = { ...empty };
  let num = 0, den = 0;
  for (const [name, lo, hi] of BANDS) {
    let p = 0;
    for (let k = 1; k < N / 2; k++) if (hz(k) >= lo && hz(k) < hi) p += power[k];
    bands[name] = r1(db(p * scale));
  }
  for (let k = 1; k < N / 2; k++) {
    num += hz(k) * power[k];
    den += power[k];
  }
  return {
    seconds: r1(len / sampleRate),
    level_db: r1(level),
    peak_db: r1(db(peak * peak)),
    crest_db: r1(db(shortPeak) - level),
    spread_db: r1(loud.length > 1 ? percentile(loud, 95) - percentile(loud, 10) : 0),
    brightness_hz: Math.round(den ? num / den : 0),
    bands,
    width: Math.round((em > 0 ? Math.sqrt(es / em) : 0) * 100) / 100,
  };
}

/** One line per feature that moved, largest change first (dB for levels, % for brightness). */
export function compare(before: Features, after: Features): string[] {
  if (before.silent || after.silent) return [after.silent ? 'the processed track is silent' : 'the track was silent before'];
  const rows: [number, string][] = [];
  const dB = (label: string, a: number, b: number, min = 0.5, extra = '') => {
    const d = b - a;
    if (Math.abs(d) >= min) rows.push([Math.abs(d), `${label} ${d > 0 ? '+' : ''}${r1(d)} dB (${a} -> ${b})${extra}`]);
  };
  dB('level', before.level_db, after.level_db);
  dB('peak', before.peak_db, after.peak_db);
  dB('crest', before.crest_db, after.crest_db, 1, after.crest_db < before.crest_db ? ', peaks flattened' : ', peaks stand out more');
  dB('loud-quiet spread', before.spread_db, after.spread_db, 1, after.spread_db < before.spread_db ? ', loud and quiet parts closer together' : ', loud and quiet parts further apart');
  // band changes against the least-changed band: a gain move shifts every band alike and reads as
  // no EQ, and a cut in the highs doesn't make the untouched lows look boosted (as the overall
  // level or the median band would when the cut spans most bands)
  const heard = BANDS.map(([b]) => b).filter((b) => before.bands[b] > before.level_db - 60 || after.bands[b] > after.level_db - 60);
  const change = (b: Band) => after.bands[b] - before.bands[b];
  const ref = heard.length ? heard.map(change).sort((x, y) => Math.abs(x) - Math.abs(y))[0] : 0;
  for (const b of heard) {
    const d = change(b) - ref;
    if (Math.abs(d) >= 1) rows.push([Math.abs(d), `${b.replace('_', '-')} band ${d > 0 ? '+' : ''}${r1(d)} dB vs the least-changed band`]);
  }
  const pct = before.brightness_hz ? ((after.brightness_hz - before.brightness_hz) / before.brightness_hz) * 100 : 0;
  if (Math.abs(pct) >= 3) rows.push([Math.abs(pct) / 5, `brightness ${pct > 0 ? '+' : ''}${Math.round(pct)}% (${before.brightness_hz} -> ${after.brightness_hz} Hz)`]);
  const dw = after.width - before.width;
  if (Math.abs(dw) >= 0.05) rows.push([Math.abs(dw) * 20, `stereo width ${dw > 0 ? '+' : ''}${Math.round(dw * 100) / 100} (${before.width} -> ${after.width})`]);
  return rows.length ? rows.sort((a, b) => b[0] - a[0]).map(([, t]) => t) : ['no measurable change'];
}
