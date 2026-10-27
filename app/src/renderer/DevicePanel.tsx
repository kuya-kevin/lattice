// Device panel (S1): the selected track's insert chain, generated from the knob catalog.
// Knob drags preview live (no session change); releasing commits through set_param, which
// the tool layer logs as a hand edit Muse sees on its next turn.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CATALOG, formatValue, fromNorm, getDevice, toNorm, type ParamDef, type ParamValue } from '../fx/catalog';
import { previewParam, syncFx, trackLatency, trackMeters, warmUp, withTrackFx } from '../fx/engine/live';
import type { DeviceInstance, Session } from '../core/session';
import './DevicePanel.css';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>;

export { withTrackFx };

/** Keeps the live effect chains in step with the session (call once in App). */
export function useFxEngine(session: Session | null) {
  useEffect(() => {
    warmUp().catch((e) => console.warn('[fx] warm-up failed', e));
  }, []);
  useEffect(() => {
    if (session) syncFx(session);
  }, [session]);
}

export function DevicePanel({ session, run }: { session: Session; run: Run }) {
  const track = session.tracks.find((t) => t.id === session.selection.trackId) ?? session.tracks[0];
  const [open, setOpen] = useState(true);
  const meters = useMeters(track?.id);
  if (!track) return null;
  const latencyMs = Math.round(trackLatency(track.id) * 10000) / 10;
  return (
    <section className="fx-panel" data-testid="device-panel">
      <header>
        <button className="fx-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Effects panel">
          {open ? '▾' : '▸'} Effects: {track.name} <small>{track.id}</small>
        </button>
        {latencyMs > 0 && <span className="fx-latency">latency {latencyMs} ms</span>}
        <select
          data-testid="fx-add"
          aria-label="Add device"
          value=""
          onChange={(e) => e.target.value && run('insert_device', { track_id: track.id, device: e.target.value })}
        >
          <option value="">+ Add device…</option>
          {CATALOG.devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </header>
      {open && (
        <div className="fx-chain">
          {track.devices.length === 0 && <div className="fx-empty">No devices. Add one, or ask Muse (e.g. "make the vocal brighter").</div>}
          {track.devices.map((d, i) => (
            <DeviceCard key={d.id} trackId={track.id} dev={d} index={i} count={track.devices.length} run={run} meters={meters[d.id]} />
          ))}
        </div>
      )}
    </section>
  );
}

function useMeters(trackId: string | undefined) {
  const [m, setM] = useState<Record<string, Record<string, number>>>({});
  useEffect(() => {
    if (!trackId) return;
    const t = setInterval(() => setM(trackMeters(trackId)), 120);
    return () => clearInterval(t);
  }, [trackId]);
  return m;
}

function DeviceCard({ trackId, dev, index, count, run, meters }: { trackId: string; dev: DeviceInstance; index: number; count: number; run: Run; meters?: Record<string, number> }) {
  const def = getDevice(dev.kind);
  const groups = useMemo(() => {
    const g = new Map<string, ParamDef[]>();
    for (const p of def.params) {
      const k = p.group ?? '';
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(p);
    }
    return [...g.entries()];
  }, [def]);
  const gr = meters?.gr_db;
  const grDb = gr === undefined ? undefined : dev.kind === 'comp' || dev.kind === 'deess' ? -gr : gr;
  return (
    <div className={`fx-device${dev.on ? '' : ' off'}`} data-testid={`device-${dev.id}`}>
      <div className="fx-device-head">
        <label className="fx-power" title={dev.on ? 'Bypass' : 'Enable'}>
          <input type="checkbox" checked={dev.on} onChange={(e) => run('bypass_device', { track_id: trackId, device_id: dev.id, on: e.target.checked })} />
        </label>
        <strong title={def.logicRef ? `like Logic ${def.logicRef}` : undefined}>{def.label}</strong>
        <small>{dev.id}</small>
        {grDb !== undefined && (
          <span className="fx-gr" title="gain reduction" data-testid={`gr-${dev.id}`}>
            <span style={{ width: `${Math.min(100, (Math.abs(Math.min(0, grDb)) / 24) * 100)}%` }} />
            {grDb.toFixed(1)} dB
          </span>
        )}
        <span className="fx-spacer" />
        <button disabled={index === 0} onClick={() => run('move_device', { track_id: trackId, device_id: dev.id, position: index - 1 })} aria-label="Move left">
          ‹
        </button>
        <button disabled={index === count - 1} onClick={() => run('move_device', { track_id: trackId, device_id: dev.id, position: index + 1 })} aria-label="Move right">
          ›
        </button>
        <button onClick={() => run('remove_device', { track_id: trackId, device_id: dev.id })} aria-label={`Remove ${def.label}`}>
          ×
        </button>
      </div>
      <div className="fx-params">
        {groups.map(([g, ps]) => (
          <div className="fx-group" key={g || '_'}>
            {g && <div className="fx-group-name">{g}</div>}
            {ps.map((p) => (
              <Knob key={p.id} trackId={trackId} dev={dev} p={p} value={dev.params[p.id]} run={run} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const STEPS = 1000;

function Knob({ trackId, dev, p, value, run }: { trackId: string; dev: DeviceInstance; p: ParamDef; value: ParamValue; run: Run }) {
  const id = `param-${dev.id}-${p.id}`;
  const commit = (v: ParamValue) => v !== value && run('set_param', { track_id: trackId, device_id: dev.id, param: p.id, value: v });
  if (p.type === 'bool') {
    return (
      <label className="fx-knob fx-bool" title={p.help}>
        <input type="checkbox" data-testid={id} checked={Boolean(value)} onChange={(e) => commit(e.target.checked)} />
        {p.label}
      </label>
    );
  }
  if (p.type === 'enum') {
    return (
      <label className="fx-knob" title={p.help}>
        <span>{p.label}</span>
        <select data-testid={id} value={String(value)} onChange={(e) => commit(p.options!.find((o) => String(o) === e.target.value)!)}>
          {p.options!.map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
              {p.unit && typeof o === 'number' ? ` ${p.unit}` : ''}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return <Slider id={id} trackId={trackId} dev={dev} p={p} value={Number(value)} commit={commit} />;
}

function Slider({ id, trackId, dev, p, value, commit }: { id: string; trackId: string; dev: DeviceInstance; p: ParamDef; value: number; commit: (v: number) => void }) {
  // The slider keeps its own travel position, so small keyboard steps accumulate even when the
  // value they map to rounds to the same param step.
  const toPos = (v: number) => Math.round(toNorm(p, v) * STEPS);
  const [pos, setPos] = useState(toPos(value));
  const local = fromNorm(p, pos / STEPS);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current && toPos(value) !== pos && fromNorm(p, pos / STEPS) !== value) setPos(toPos(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const setLocal = (v: number) => setPos(toPos(v));
  const done = () => {
    dragging.current = false;
    commit(local);
  };
  return (
    <label className="fx-knob" title={p.help}>
      <span>{p.label}</span>
      <input
        type="range"
        data-testid={id}
        min={0}
        max={STEPS}
        step={1}
        value={pos}
        aria-label={`${dev.kind} ${p.label}`}
        aria-valuetext={formatValue(p, local)}
        onChange={(e) => {
          dragging.current = true;
          const next = Number(e.target.value);
          setPos(next);
          previewParam(trackId, dev.id, p.id, fromNorm(p, next / STEPS));
        }}
        onPointerUp={done}
        onKeyUp={done}
        onBlur={() => dragging.current && done()}
        onDoubleClick={() => {
          setLocal(Number(p.default));
          commit(Number(p.default));
        }}
      />
      <output>{formatValue(p, local)}</output>
    </label>
  );
}
