declare name "reverb";
declare author "Lattice";
declare license "MIT";
// zita-rev1 FDN (re.zita_rev1_stereo, J.O. Smith after Fons Adriaensen, STK-4.3) with our own
// predelay, wet EQ, M/S width and dry/wet mix.
re = library("reverbs.lib");
fi = library("filters.lib");
de = library("delays.lib");
ma = library("maths.lib");

predelay = hslider("predelay", 20, 0, 200, 0.1) * 0.001;
decay = hslider("decay", 2, 0.2, 12, 0.001);
lowRatio = hslider("low_ratio", 1.2, 0.5, 2, 0.001);
xover = hslider("xover", 200, 50, 1000, 1);
damping = hslider("damping", 6000, 1500, 20000, 1);
size = hslider("size", 50, 0, 100, 0.1);
lowCut = hslider("low_cut", 200, 20, 1000, 1);
highCut = hslider("high_cut", 12000, 1000, 20000, 1);
width = hslider("width", 100, 0, 150, 0.1) * 0.01;
mix = hslider("mix", 20, 0, 100, 0.01) * 0.01;

t60m = decay * pow(2, (size - 50) / 50);
t60dc = t60m * lowRatio;
pre = de.delay(32768, int(predelay * ma.SR));
weq = fi.highpass(2, lowCut) : fi.lowpass(2, highCut);
ms(a, b) = m + width * s, m - width * s with { m = (a + b) * 0.5; s = (a - b) * 0.5; };
// rdel = 20 ms means no extra input delay inside zita (it delays by rdel - 20 ms)
wet = pre, pre : re.zita_rev1_stereo(20, xover, damping, t60dc, t60m, 96000) : weq, weq : ms;

process = _, _ <: (*(1 - mix), *(1 - mix)), (wet : *(mix), *(mix)) :> _, _;
