declare name "deess";
declare author "Lattice";
declare license "MIT";
// De-esser (docs/plugin-catalog.md section 4), our own design from STK-licensed filters:
// detector = band around freq (bandpass) or LR4 high band (highshelf); relative mode compares
// it with the full-band level (like Logic DeEsser 2 "Relative"). Above threshold the band is
// pulled down to the threshold (infinite ratio), by at most `range` dB.
fi = library("filters.lib");
c = library("common.lib");

freq = hslider("freq", 6500, 2000, 16000, 1);
thresh = hslider("thresh", -24, -60, 0, 0.01);
range = hslider("range", 6, 0, 24, 0.01);
mode = nentry("mode", 0, 0, 1, 1);   // 0 relative, 1 absolute
band = nentry("band", 0, 0, 1, 1);   // 0 split, 1 wide
shape = nentry("shape", 0, 0, 1, 1); // 0 bandpass, 1 highshelf
listen = checkbox("listen");
Q = 1.4;

bp(x) = x - fi.svf.notch(freq, Q, x);   // unity-peak band-pass
hb(x) = x : fi.highpassLR4(freq);
detect(x) = select2(shape, bp(x), hb(x));
env(x) = abs(x) : c.branch(0.0005, 0.020); // 0.5 ms attack, 20 ms release

grDb(l, r) = min(range, max(0, lvl - thresh)) : hbargraph("gr_db", 0, 24)
with {
  m = (l + r) * 0.5;
  bandDb = c.lin2db(env(detect(m)));
  fullDb = c.lin2db(env(m));
  lvl = select2(mode, bandDb - fullDb, bandDb);
};

chan(g, x) = select2(listen, select2(band, split, x * g), detect(x))
with {
  split = select2(shape, fi.svf.notch(freq, Q, x) * (1 - g) + x * g,
                         (x : fi.crossover2LR4(freq) : _, *(g) :> _));
};

process(l, r) = chan(g, l), chan(g, r) with { g = c.db2lin(0 - grDb(l, r)); };
