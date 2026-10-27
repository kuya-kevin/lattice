// [S3 midi] "Extract MIDI" toolbar control: runs the extract_midi tool (source-prep sidecar) on
// the selected audio clip, and hands each source's audio to the sidecar side as a mono WAV.
import { useState } from 'react';
import type { Bridge } from '../core/bridge';
import type { Session } from '../core/session';
import { encodeWavMono } from '../core/wav';
import { buffers } from './audio';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

const MODES = [
  ['auto', 'Auto'],
  ['hum', 'Hum / voice'],
  ['keys', 'Keys'],
  ['bass', 'Bass'],
  ['drums', 'Drums / beatbox'],
  ['layered', 'Layered'],
] as const;

const uploaded = new WeakMap<AudioBuffer, string>();

/** Send a source's audio to the sidecar side once per buffer (fire and forget). */
export function uploadSourceAudio(bridge: Bridge, sourceId: string, b: AudioBuffer): Promise<void> {
  if (uploaded.get(b) === sourceId) return Promise.resolve();
  uploaded.set(b, sourceId);
  const chans = Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
  return bridge.putSourceAudio(sourceId, encodeWavMono(chans, b.sampleRate)).catch(() => uploaded.delete(b) as unknown as void);
}

/** The audio clip Extract MIDI works on: the selected clip, else the first audio clip of the selected track. */
export function extractTarget(s: Session): { clipId: string; sourceId: string } | null {
  const all = s.tracks.flatMap((t) => t.clips.map((c) => ({ t, c })));
  const sel = all.find(({ c }) => c.id === s.selection.clipId) ?? all.find(({ t, c }) => t.id === s.selection.trackId && !c.midi);
  return sel && !sel.c.midi ? { clipId: sel.c.id, sourceId: sel.c.sourceId } : null;
}

export function ExtractMidiControl({ session, bridge, run }: { session: Session; bridge: Bridge; run: Run }) {
  const [mode, setMode] = useState<string>('auto');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const target = extractTarget(session);
  const go = async () => {
    if (!target || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const b = buffers.get(target.sourceId);
      if (b) await uploadSourceAudio(bridge, target.sourceId, b);
      const r = await run('extract_midi', { clip_id: target.clipId, mode });
      if (r.ok) {
        const res = r.result;
        const parts = res.tracks.map((t: any) => `${t.stem} ${t.notes}`).join(', ');
        const tempo = res.tempo ? `${res.tempo.bpm} BPM${res.tempo.quantized ? '' : ' (not quantized)'}` : 'no tempo';
        setNote(`${res.content}: ${parts || 'no notes'} · ${tempo}${res.key ? ` · ${res.key}` : ''}`);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="group" data-testid="extract-midi">
      <select aria-label="Extract MIDI mode" value={mode} onChange={(e) => setMode(e.target.value)} disabled={busy} title="What the recording is">
        {MODES.map(([v, label]) => (
          <option key={v} value={v}>{label}</option>
        ))}
      </select>
      <button onClick={go} disabled={!target || busy} title={target ? 'Isolate parts and transcribe the selected clip to MIDI tracks' : 'Select an audio clip first'}>
        {busy ? 'Extracting…' : 'Extract MIDI'}
      </button>
      {note && <span className="tb-label" data-testid="extract-midi-result" title={note}>{note.length > 60 ? `${note.slice(0, 57)}…` : note}</span>}
    </div>
  );
}
