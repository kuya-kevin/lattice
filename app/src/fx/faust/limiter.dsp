declare name "limiter";
declare author "Lattice";
declare license "MIT";
// Lookahead brick-wall limiter (sample peak), our own design; limiter_lad_* (GPL-3.0) is not used.
// Gain needed per sample g = min(1, ceiling / |x|), then a sliding minimum over L+1 samples and
// a moving average over L samples: every output gain is <= the gain its delayed sample needs,
// so the output never exceeds the ceiling. Release is a one-pole that only moves upward.
// (Lookahead limiting as in Zolzer, DAFX 2nd ed. ch. 4 and Reiss & McPherson, Audio Effects ch. 6.)
ba = library("basics.lib");
de = library("delays.lib");
ma = library("maths.lib");
c = library("common.lib");

gainIn = c.db2lin(hslider("gain", 0, 0, 24, 0.01));
ceilLin = c.db2lin(hslider("ceiling", -1, -12, 0, 0.01));
rel = hslider("release", 60, 1, 1000, 0.01) * 0.001;
la = hslider("lookahead", 5, 0, 10, 0.01) * 0.001;
tp = checkbox("true_peak"); // v1.1: accepted, not used yet
MAXL = 2048;
L = max(1, min(MAXL - 2, int(la * ma.SR + 0.5)));

// computed on the reduction r = 1 - g so that the zero-initialised windows and state mean "no reduction"
limGain(l, r) = 1 - (red : ba.slidingMax(L + 1, MAXL) : ba.slidingMeanp(L, MAXL) : (relStep ~ _))
with {
  red = 1 - min(1, ceilLin / max(max(abs(l), abs(r)), 1e-9));
  relStep(prev, x) = select2(x > prev, prev + (1 - c.coef(rel)) * (x - prev), x);
};

process(l0, r0) = de.delay(MAXL, L, l) * g, de.delay(MAXL, L, r) * g with {
  l = l0 * gainIn;
  r = r0 * gainIn;
  g0 = limGain(l, r) + 0 * tp;
  g = attach(g0, c.lin2db(g0) : hbargraph("gr_db", -60, 0));
};
