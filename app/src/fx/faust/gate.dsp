declare name "gate";
declare author "Lattice";
declare license "MIT";
// Noise gate in the structure of ef.gate_stereo (J.O. Smith, STK-4.3) with what Logic's Noise
// Gate adds: reduction range, hysteresis (Schmitt trigger), hold and key filters. Our own code.
fi = library("filters.lib");
ma = library("maths.lib");
c = library("common.lib");

thresh = hslider("thresh", -50, -90, 0, 0.01);
range = hslider("range", -40, -90, 0, 0.01);
hyst = hslider("hyst", 3, 0, 12, 0.01);
att = hslider("attack", 1, 0.1, 50, 0.01) * 0.001;
hold = hslider("hold", 30, 0, 500, 0.1) * 0.001;
rel = hslider("release", 100, 5, 2000, 0.1) * 0.001;
khp = hslider("key_hpf", 20, 20, 2000, 1);
klp = hslider("key_lpf", 20000, 1000, 20000, 1);

// key filters are off at their range ends (20 Hz / 20 kHz)
key(x) = x <: select2(khp > 20.5, _, fi.highpass(2, khp)) <: select2(klp < 19999, _, fi.lowpass(2, klp));

// gain is smoothed in dB (like the compressor; Giannoulis et al. 2012 recommend log-domain smoothing),
// so attack/release are time constants of the fade in dB
gateGain(l, r) = targetDb : c.branch(att, rel) : c.db2lin
with {
  lvl = c.lin2db(max(abs(key(l)), abs(key(r))) : c.branch(0, 0.010));
  opens = lvl > thresh;
  closes = lvl < thresh - hyst;
  state = schmitt ~ _ with { schmitt(prev) = select2(prev, opens, 1 - closes); };
  since = (+(1) : *(1 - state)) ~ _;            // samples since the trigger closed
  isOpen = max(state, since < hold * ma.SR);
  targetDb = select2(isOpen, range, 0);
};

process(l, r) = l * g, r * g with {
  g0 = gateGain(l, r);
  g = attach(g0, c.lin2db(g0) : hbargraph("gr_db", -90, 0));
};
