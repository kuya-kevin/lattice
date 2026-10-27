// Shared helpers for the static UI mocks: fake waveforms, MIDI lanes, knobs, wires, pan/zoom.
// Everything is seeded, so screenshots are stable.

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// <canvas class="wave" data-seed="3" data-color="var(--t1)" data-style="hum|keys|drums|vocal">
function drawWaves(root = document) {
  root.querySelectorAll('canvas.wave').forEach((c) => {
    const w = c.clientWidth, h = c.clientHeight, dpr = 2;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d'); g.scale(dpr, dpr);
    const r = rng(+c.dataset.seed || 1);
    const style = c.dataset.style || 'hum';
    g.fillStyle = getComputedStyle(c).color;
    const mid = h / 2;
    let env = 0.2;
    for (let x = 0; x < w; x += 2) {
      const t = x / w;
      if (style === 'drums') env = (x % 46 < 4) ? 1 : env * 0.86;
      else if (style === 'keys') env = (x % 92 < 3) ? 0.9 : Math.max(0.18, env * 0.975);
      else env += (0.35 + 0.45 * Math.sin(t * 9 + r()) * Math.sin(t * 3.1) - env) * 0.12;
      const a = Math.max(0.04, Math.abs(env) * (0.55 + 0.45 * r())) * mid * 0.92;
      g.fillRect(x, mid - a, 1.4, a * 2);
    }
  });
}

// <div class="midi" data-seed="4" data-count="40" data-lo="0" data-hi="1" data-style="melody|chords|drums|bass">
function drawMidi(root = document) {
  root.querySelectorAll('.midi').forEach((el) => {
    const r = rng(+el.dataset.seed || 1), n = +el.dataset.count || 30, style = el.dataset.style || 'melody';
    const h = el.clientHeight;
    let y = 0.5, html = '';
    for (let i = 0; i < n; i++) {
      const x = (i / n) * 100;
      if (style === 'drums') {
        const row = [0.8, 0.5, 0.2][i % 3 === 0 ? 0 : (i % 4 === 2 ? 1 : 2)];
        html += `<i style="left:${x}%;width:1.2%;top:${row * (h - 4)}px"></i>`;
        continue;
      }
      const len = style === 'chords' ? 100 / n * 0.92 : (100 / n) * (0.4 + r() * 0.9);
      y = Math.min(0.92, Math.max(0.05, y + (r() - 0.5) * (style === 'bass' ? 0.5 : 0.28)));
      const voices = style === 'chords' ? 3 : 1;
      for (let v = 0; v < voices; v++) {
        html += `<i style="left:${x}%;width:${len}%;top:${(y - v * 0.13) * (h - 4)}px"></i>`;
      }
    }
    el.innerHTML = html;
  });
}

// <div class="knob" data-v="0.6" data-name="Thresh" data-val="−18 dB" data-color="var(--t5)">
function drawKnobs(root = document) {
  root.querySelectorAll('.knob').forEach((k) => {
    const v = +k.dataset.v, col = k.dataset.color || 'var(--accent)';
    const a0 = -225, a1 = 45, R = 17, cx = 22, cy = 22;
    const pt = (deg) => {
      const rad = (deg * Math.PI) / 180;
      return [cx + R * Math.cos(rad), cy + R * Math.sin(rad)];
    };
    const arc = (from, to) => {
      const [x0, y0] = pt(from), [x1, y1] = pt(to);
      return `M${x0} ${y0} A${R} ${R} 0 ${to - from > 180 ? 1 : 0} 1 ${x1} ${y1}`;
    };
    const av = a0 + (a1 - a0) * v, [px, py] = pt(av);
    k.innerHTML = `<svg viewBox="0 0 44 44" aria-hidden="true">
        <path d="${arc(a0, a1)}" fill="none" stroke="var(--line-strong)" stroke-width="3" stroke-linecap="round"/>
        <path d="${arc(a0, av)}" fill="none" stroke="${col}" stroke-width="3" stroke-linecap="round"/>
        <circle cx="22" cy="22" r="11" fill="var(--island-2)" stroke="var(--line)"/>
        <line x1="22" y1="22" x2="${cx + (px - cx) * 0.55}" y2="${cy + (py - cy) * 0.55}" stroke="var(--text)" stroke-width="2" stroke-linecap="round"/>
      </svg><span class="k-name">${k.dataset.name}</span><span class="k-val">${k.dataset.val}</span>`;
  });
}

// Bezier wires between [data-port="id"] elements inside a positioned world.
// wires: [[fromId, toId, color]]
function drawWires(world, svg, wires) {
  const wr = world.getBoundingClientRect(), s = wr.width / world.offsetWidth;
  const pos = (id, side) => {
    const r = world.querySelector(`[data-port="${id}"]`).getBoundingClientRect();
    return [((side === 'out' ? r.right : r.left) - wr.left) / s, (r.top + r.height / 2 - wr.top) / s];
  };
  svg.innerHTML = wires.map(([a, b, col, dash]) => {
    const [x0, y0] = pos(a, 'out'), [x1, y1] = pos(b, 'in'), dx = Math.max(60, (x1 - x0) / 2);
    return `<path d="M${x0} ${y0} C${x0 + dx} ${y0} ${x1 - dx} ${y1} ${x1} ${y1}" fill="none"
      stroke="${col}" stroke-width="2" ${dash ? 'stroke-dasharray="5 6"' : ''} opacity=".85"/>
      <circle cx="${x0}" cy="${y0}" r="4" fill="${col}"/><circle cx="${x1}" cy="${y1}" r="4" fill="var(--ground)" stroke="${col}" stroke-width="2"/>`;
  }).join('');
}

// Drag to pan, ctrl/⌘+wheel or pinch to zoom; updates a "NN%" readout.
function panZoom(viewport, world, readout, init = { x: 0, y: 0, k: 1 }) {
  let { x, y, k } = init;
  const apply = () => {
    world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    viewport.style.backgroundPosition = `${x}px ${y}px`;
    viewport.style.backgroundSize = `${22 * k}px ${22 * k}px`;
    if (readout) readout.textContent = `${Math.round(k * 100)}%`;
  };
  let drag = null;
  viewport.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.island, button, .knob')) return;
    drag = { sx: e.clientX - x, sy: e.clientY - y }; viewport.setPointerCapture(e.pointerId);
    viewport.style.cursor = 'grabbing';
  });
  viewport.addEventListener('pointermove', (e) => { if (drag) { x = e.clientX - drag.sx; y = e.clientY - drag.sy; apply(); } });
  viewport.addEventListener('pointerup', () => { drag = null; viewport.style.cursor = ''; });
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const nk = Math.min(2, Math.max(0.25, k * Math.exp(-e.deltaY * 0.01)));
      x = e.clientX - (e.clientX - x) * (nk / k); y = e.clientY - (e.clientY - y) * (nk / k); k = nk;
    } else { x -= e.deltaX; y -= e.deltaY; }
    apply();
  }, { passive: false });
  apply();
}

const ICON = {
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/></svg>',
  rec: '<svg viewBox="0 0 24 24" fill="var(--rec)"><circle cx="12" cy="12" r="6"/></svg>',
  loop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l3 3-3 3"/><path d="M4 12V9a3 3 0 0 1 3-3h13"/><path d="M7 21l-3-3 3-3"/><path d="M20 12v3a3 3 0 0 1-3 3H4"/></svg>',
  metro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M9 3h6l4 18H5z"/><path d="M12 15l5-8"/></svg>',
  cursor: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 7-6 2-2 6z"/></svg>',
  hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V12M14 11.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3.6 16.6a1.5 1.5 0 0 1 2.3-1.9L8 16.5"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 20l1-4L16 5l3 3L8 19z"/></svg>',
  scissors: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.5 7.5L20 18M8.5 16.5L20 6"/></svg>',
  marquee: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-dasharray="3 3"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  library: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 4v16M10 4v16M15 5l4 15"/></svg>',
  knob: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><path d="M12 12l3-4"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/></svg>',
  export: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z"/></svg>',
};
function icons(root = document) {
  root.querySelectorAll('[data-i]').forEach((el) => { el.innerHTML = ICON[el.dataset.i] + el.innerHTML; });
}

function renderAll() { icons(); drawWaves(); drawMidi(); drawKnobs(); }
