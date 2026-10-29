import { describe, expect, it } from 'vitest';
import * as S from '../src/core/session';

function withClip() {
  let s = S.addSource(S.emptySession(), { id: 'src1', name: 'Vox', duration: 10, origin: 'import' });
  const [s1, t] = S.addTrack(s, 'Vox');
  const [s2, c] = S.addClip(s1, t.id, 'src1', 1);
  return { s: s2, t, c };
}

describe('session model', () => {
  it('assigns short sequential ids', () => {
    const { t, c } = withClip();
    expect(t.id).toBe('t1');
    expect(c.id).toBe('c2');
  });

  it('trims a clip and keeps the audio in place', () => {
    const { s, c } = withClip(); // source occupies 1..11 s on the timeline
    const s2 = S.trimClip(s, c.id, 3, 6);
    const clip = S.findClip(s2, c.id).clip;
    expect(clip).toMatchObject({ start: 3, offset: 2, duration: 3 });
    // widening again is clamped to the recorded audio
    const s3 = S.trimClip(s2, c.id, 0, 50);
    expect(S.findClip(s3, c.id).clip).toMatchObject({ start: 1, offset: 0, duration: 10 });
  });

  it('rejects a trim that leaves nothing', () => {
    const { s, c } = withClip();
    expect(() => S.trimClip(s, c.id, 20, 30)).toThrow(S.SessionError);
  });

  it('clamps gain and toggles mute/solo', () => {
    const { s, t } = withClip();
    const s2 = S.setSolo(S.setMute(S.setGain(s, t.id, -100), t.id, true), t.id, true);
    expect(S.getTrack(s2, t.id)).toMatchObject({ gainDb: -60, muted: true, soloed: true });
  });

  it('arms punch-in only on valid ranges', () => {
    const { s, t } = withClip();
    expect(S.armPunchIn(s, t.id, 4, 8).punchIn).toEqual({ trackId: 't1', start: 4, end: 8 });
    expect(() => S.armPunchIn(s, t.id, 8, 4)).toThrow();
    expect(() => S.armPunchIn(s, 'nope', 1, 2)).toThrow(/no track/);
  });

  it('summarizes for Muse', () => {
    const { s } = withClip();
    expect(S.summarize(s)).toContain('t1 "Vox" gain 0 dB: c2 "Vox" 1-11s');
    expect(S.summarize(S.emptySession())).toMatch(/empty/);
  });

  it('is immutable', () => {
    const { s, t } = withClip();
    const before = JSON.stringify(s);
    S.setGain(s, t.id, -3);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('has tempo, signature, key and click, with validation', () => {
    let s = S.emptySession();
    expect(s).toMatchObject({ tempo: 120, timeSignature: [4, 4], key: null, metronome: { on: false, countIn: false } });
    s = S.setKey(S.setTimeSignature(S.setTempo(s, 92), 6, 8), 'gm');
    s = S.setMetronome(s, true);
    expect(s).toMatchObject({ tempo: 92, timeSignature: [6, 8], key: 'G minor', metronome: { on: true, countIn: false } });
    expect(() => S.setTempo(s, 300)).toThrow(/40-240/);
    expect(() => S.setTimeSignature(s, 4, 3)).toThrow();
    expect(() => S.setKey(s, 'H minor')).toThrow(/unknown key/);
    expect(S.setKey(s, '').key).toBeNull();
    expect(S.summarize(s)).toMatch(/^Tempo 92 BPM, 6\/8, key G minor, click on\./);
  });

  it('parses keys leniently', () => {
    expect(S.parseKey('F# maj')).toBe('F# major');
    expect(S.parseKey('Db minor')).toBe('C# minor');
    expect(S.parseKey('bb')).toBe('Bb major');
    expect(S.parseKey('Bbm')).toBe('Bb minor');
    expect(S.parseKey('E♭ Major')).toBe('Eb major');
    expect(S.parseKey('A MINOR')).toBe('A minor');
    expect(S.parseKey('nope')).toBeNull();
    expect(S.KEYS).toHaveLength(24);
  });

  it('transport commands bump rev so repeats replay', () => {
    let s = S.setTransport(S.emptySession(), 'play', 2);
    s = S.setTransport(s, 'play', 2);
    expect(s.transport).toEqual({ playing: true, position: 2, command: 'play', rev: 2 });
    s = S.setTransport(s, 'locate', 0);
    expect(s.transport).toMatchObject({ playing: true, position: 0, command: 'locate' });
    s = S.setTransport(s, 'stop', 1.5);
    expect(s.transport).toMatchObject({ playing: false, position: 1.5 });
  });
});

describe('changeTempo (regions keep their bar positions, as in Logic and GarageBand)', () => {
  function withMidi() {
    let { s, t, c } = withClip(); // audio: src1 (10 s) at 1 s
    const [s1, m] = S.addMidiClip(s, t.id, { name: 'Keys', sourceDuration: 2, start: 4, midi: { instrument: 'piano', notes: [{ pitch: 60, velocity: 100, start: 0.5, duration: 0.25 }] } }); // bar 3 at 120 BPM
    s = s1;
    s = S.armPunchIn(s, t.id, 2, 6);
    return { s, audio: c, midi: m };
  }

  it('moves region starts with the bars; MIDI notes stretch, audio content does not', () => {
    const { s, audio, midi } = withMidi();
    const s2 = S.changeTempo(s, 60); // everything twice as long
    expect(s2.tempo).toBe(60);
    const a = S.findClip(s2, audio.id).clip;
    expect(a).toMatchObject({ start: 2, offset: 0, duration: 10 }); // audio isn't time-stretched
    const m = S.findClip(s2, midi.id).clip;
    expect(m).toMatchObject({ start: 8, offset: 0, duration: 4 });
    expect(m.midi!.notes[0]).toMatchObject({ start: 1, duration: 0.5 });
    expect(s2.sources[m.sourceId].duration).toBe(4);
    expect(s2.punchIn).toMatchObject({ start: 4, end: 12 });
  });

  it('a trimmed MIDI region keeps its trim in beats', () => {
    const { s, midi } = withMidi();
    const s1 = S.trimClip(s, midi.id, 4.5, 6); // offset 0.5 into the source
    const m = S.findClip(S.changeTempo(s1, 240), midi.id).clip;
    expect(m).toMatchObject({ start: 2.25, offset: 0.25, duration: 0.75 });
  });

  it('a stopped playhead stays on its bar (a locate, so the engine follows); a playing one is left to the renderer', () => {
    const s = S.setTransport(withMidi().s, 'locate', 4);
    expect(S.changeTempo(s, 60).transport).toMatchObject({ position: 8, command: 'locate', rev: s.transport.rev + 1 });
    const p = S.setTransport(s, 'play', 4);
    expect(S.changeTempo(p, 60).transport).toEqual(p.transport);
  });

  it('validates like setTempo', () => {
    expect(() => S.changeTempo(withMidi().s, 300)).toThrow(/40-240/);
  });
});
