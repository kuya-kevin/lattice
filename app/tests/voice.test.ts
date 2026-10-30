// B14 "Muse talks back": the set_voice_reply tool, what Muse sees, and what gets spoken.
import { describe, expect, it } from 'vitest';
import { StubSidecar } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { museSummary, museToolSpecs, runTool, type ToolContext } from '../src/core/tools';
import { LONG_REPLY, numberWords, speakable, spokenReply } from '../src/core/voiceTools';
import { MockVoice, pickVoice } from '../src/renderer/voice';
import { VoiceReply } from '../src/renderer/voiceReply';

function ctx(): ToolContext {
  return { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) };
}

describe('set_voice_reply', () => {
  it('is off by default, turns on and off, and Muse sees it only while on', async () => {
    const c = ctx();
    expect(c.store.get().voiceReply).toBeUndefined();
    expect(museSummary(c)).not.toMatch(/Voice replies/);

    const on = await runTool(c, 'set_voice_reply', { on: true }, 'user');
    expect(on).toEqual({ ok: true, result: { voice_reply: true } });
    expect(c.store.get().voiceReply).toBe(true);
    expect(museSummary(c)).toMatch(/Voice replies: on/);

    expect((await runTool(c, 'set_voice_reply', { on: false }, 'user')).ok).toBe(true);
    expect(c.store.get().voiceReply).toBe(false);
    expect(museSummary(c)).not.toMatch(/Voice replies/);
  });

  it('Muse can call it; arguments are checked', async () => {
    const c = ctx();
    expect(museToolSpecs().some((t) => t.function.name === 'set_voice_reply')).toBe(true);
    expect((await runTool(c, 'set_voice_reply', { on: true }, 'muse')).ok).toBe(true);
    expect((await runTool(c, 'set_voice_reply', {}, 'muse')).error).toMatch(/missing required argument "on"/);
    expect((await runTool(c, 'set_voice_reply', { on: 'yes' }, 'muse')).error).toMatch(/must be a boolean/);
  });

  it('is a preference: no undo step, not logged as a hand edit, and undo of other edits keeps it', async () => {
    const c = ctx();
    await runTool(c, 'set_tempo', { bpm: 100 }, 'user');
    c.store.takeUserEdits();
    await runTool(c, 'set_voice_reply', { on: true }, 'user');
    expect(c.store.takeUserEdits()).toEqual([]);
    expect((await runTool(c, 'undo', {}, 'user')).result).toEqual({ undone: expect.stringMatching(/set_tempo|tempo/) });
    expect(c.store.get().tempo).toBe(120);
    expect(c.store.get().voiceReply).toBe(true);
  });
});

describe('spokenReply', () => {
  it('says a short confirmation or question whole', () => {
    expect(spokenReply('Panned the double 30 percent right.')).toBe('Panned the double 30 percent right.');
    expect(spokenReply('Brighter how: raise the top end, or cut the low mids?')).toBe('Brighter how: raise the top end, or cut the low mids?');
  });

  it('says only the first sentence of a long reply', () => {
    const long = 'Added a compressor to the bass. ' + 'It now sits under the kick with a 4:1 ratio, a slow attack and a fast release, so the plucks keep their bite. '.repeat(2);
    expect(long.length).toBeGreaterThan(LONG_REPLY);
    expect(spokenReply(long)).toBe('Added a compressor to the bass.');
  });

  it('drops markdown, bullets and links', () => {
    expect(spokenReply('**Done.** See `t1`.')).toBe('Done. See t1.');
    expect(spokenReply('- Cut the mud\n- Boosted air at https://x.y/z.mp3')).toBe('Cut the mud Boosted air at');
    expect(spokenReply('   ')).toBe('');
  });

  it('cuts a long run-on sentence at a word', () => {
    const s = spokenReply('word '.repeat(80));
    expect(s.length).toBeLessThanOrEqual(LONG_REPLY + 1);
    expect(s).toMatch(/word\.$/);
  });
});

describe('speakable (MMS-TTS reads letters only)', () => {
  it('writes numbers out', () => {
    expect(numberWords(0)).toBe('zero');
    expect(numberWords(30)).toBe('thirty');
    expect(numberWords(118)).toBe('one hundred eighteen');
    expect(numberWords(2500)).toBe('two thousand five hundred');
  });

  it('writes numbers, units, ranges and ordinals as words', () => {
    expect(speakable('Panned the double 30 percent right.')).toBe('Panned the double thirty percent right.');
    expect(speakable('Cut 3 dB at 250 Hz, boost +2.5 dB at 8 kHz.')).toBe('Cut three decibels at two hundred fifty hertz, boost plus two point five decibels at eight kilohertz.');
    expect(speakable('Trimmed to 2–9 s at 120 BPM, -6 dB.')).toBe('Trimmed to two to nine seconds at one hundred twenty bee pee em, minus six decibels.');
    expect(speakable('Panned 30% left; 1 s fade.')).toBe('Panned thirty percent left; one second fade.');
    expect(speakable('Moved it to the 3rd bar, the 21st and 40th too.')).toBe('Moved it to the third bar, the twenty first and fortieth too.');
    expect(speakable('Quantized the drums to sixteenths.')).toBe('Quantized the drums to sixteenths.');
  });
});

describe('VoiceReply (renderer)', () => {
  function setup(recording = false) {
    const voice = new MockVoice();
    voice.msPerChar = 1; // 300 ms minimum
    const vr = new VoiceReply(voice, () => recording);
    const calls: string[] = [];
    vr.transport = { pause: () => (calls.push('pause'), 'tok'), resume: (t) => void calls.push(`resume ${t}`) };
    return { vr, calls };
  }

  it('speaks, pauses playback, and resumes when done', async () => {
    const { vr, calls } = setup();
    expect(vr.say('Moved the vocal up 2 bars.')).toBe('Moved the vocal up two bars.');
    expect(vr.speaking()).toBe(true);
    expect(calls).toEqual(['pause']);
    await new Promise((r) => setTimeout(r, 400));
    expect(vr.speaking()).toBe(false);
    expect(calls).toEqual(['pause', 'resume tok']);
  });

  it('stopping (push-to-talk) cuts it off and leaves playback paused', async () => {
    const { vr, calls } = setup();
    const seen: boolean[] = [];
    vr.subscribe((s) => seen.push(s));
    vr.say('Quantized the drums to sixteenths.');
    vr.stop();
    expect(vr.speaking()).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual(['pause']);
    expect(seen).toEqual([true, false]);
  });

  it('says nothing while recording, or when there is nothing to say', () => {
    expect(setup(true).vr.say('Added a compressor to the bass.')).toBeNull();
    const { vr, calls } = setup();
    expect(vr.say('  ')).toBeNull();
    expect(calls).toEqual([]);
    expect(vr.spoken).toEqual([]);
  });
});

describe('pickVoice (which voice speaks)', () => {
  it('Electron always uses MMS-TTS', () => {
    expect(pickVoice('electron', '', true).kind).toBe('mms');
  });
  it('the web build uses MMS-TTS too, except under automation (Playwright) or ?voice=mock', () => {
    expect(pickVoice('web', '', false).kind).toBe('mms');
    expect(pickVoice('web', '', true).kind).toBe('mock');
    expect(pickVoice('web', '?voice=mock', false).kind).toBe('mock');
    expect(pickVoice('web', '?voice=mms', true).kind).toBe('mms');
  });
});
