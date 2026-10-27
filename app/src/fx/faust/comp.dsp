declare name "comp";
declare author "Lattice";
declare license "MIT";
// Feed-forward log-domain compressor after Giannoulis, Massberg & Reiss,
// "Digital Dynamic Range Compressor Design - A Tutorial and Analysis", JAES 60(6), 2012:
// soft-knee gain computer (eq. 4) + smooth branching peak detector on the gain reduction.
// Our own code: the knee/feedback compressors in compressors.lib are GPL-3.0 and are not used.
fi = library("filters.lib");
c = library("common.lib");

thresh = hslider("thresh", -18, -60, 0, 0.01);
ratio = hslider("ratio", 3, 1, 20, 0.01);
knee = hslider("knee", 6, 0, 24, 0.01);
att = hslider("attack", 10, 0.1, 200, 0.01) * 0.001;
rel = hslider("release", 120, 10, 2000, 0.01) * 0.001;
autorel = checkbox("auto_rel");
makeup = hslider("makeup", 0, -12, 24, 0.01);
autogain = checkbox("auto_gain");
schpf = hslider("sc_hpf", 20, 20, 500, 1);
det = nentry("detector", 0, 0, 1, 1); // 0 = peak, 1 = rms
mix = hslider("mix", 100, 0, 100, 0.01) * 0.01;

// static curve: input level (dB) -> output level (dB)
gc(x) = select3(region, x, x + (1 / ratio - 1) * (x - thresh + W / 2) ^ 2 / (2 * W), thresh + (x - thresh) / ratio)
with {
  W = max(knee, 1e-6);
  region = select2(2 * (x - thresh) < -knee, select2(2 * abs(x - thresh) <= knee, 2, 1), 0);
};

// detector level in dB (stereo-linked: max of the channels)
level(l, r) = select2(det, peak, rms)
with {
  hpOn = schpf > 20.5; // 20 Hz = off
  hl = select2(hpOn, l, l : fi.highpass(2, schpf));
  hr = select2(hpOn, r, r : fi.highpass(2, schpf));
  peak = c.lin2db(max(abs(hl), abs(hr)));
  ms = max(hl * hl, hr * hr) : c.branch(0.010, 0.010); // 10 ms mean square
  rms = 10 * log10(max(ms, 1e-20));
};

// gain reduction (dB, >= 0) smoothed by the branching detector
grSmooth(xl) = xl : (step ~ _) with {
  slow = xl : c.branch(1.0, 1.0);                        // ~1 s average reduction (auto release)
  relEff = select2(autorel, rel, rel * (0.3 + 1.4 * min(1, slow / 6)));
  step(prev, in) = select2(in > prev, c.coef(relEff) * prev + (1 - c.coef(relEff)) * in,
                                      c.coef(att) * prev + (1 - c.coef(att)) * in);
};

autoMake = 0.5 * (0 - gc(0)); // half of the reduction a 0 dBFS signal would get

gainDb(l, r) = 0 - (grSmooth(max(0, xg - gc(xg))) : hbargraph("gr_db", 0, 60)) + makeup + autogain * autoMake
with { xg = level(l, r); };

process(l, r) = l * g, r * g with {
  g = (1 - mix) + mix * c.db2lin(gainDb(l, r));
};
