// B2 push-to-talk: the Muse Voice Transcribe call (recorded response, no Meta calls), the
// transcript cleanup, and the hold-to-talk key.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, clipLength, sttCostUsd, STT_MODEL } from '../src/core/stt';
import { metaTranscribe, transcriberFromEnv } from '../src/node/stt';
import { isPushToTalkKey } from '../src/renderer/shortcuts';

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/stt/transcribe-punchier.json'), 'utf8'));

describe('metaTranscribe', () => {
  it('posts the WAV as multipart in push-to-talk mode and returns the cleaned transcript', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify(fixture.response), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const wav = new Uint8Array([82, 73, 70, 70]);
    const r = await metaTranscribe(wav, { apiKey: 'k-test', fetch: fakeFetch });
    expect(r).toEqual({ text: 'Make the drums drums punchier and turn the vocal down 3 dB.', audioMs: 3360, usd: sttCostUsd(3360) });

    expect(seen!.url).toBe('https://api.meta.ai/v1/asr/transcribe');
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer k-test');
    const form = seen!.init.body as FormData;
    expect(JSON.parse(await (form.get('request') as Blob).text())).toEqual({ model: STT_MODEL, mode: 'PUSH_TO_TALK', audioEncoding: 'WAV' });
    expect(new Uint8Array(await (form.get('audio') as Blob).arrayBuffer())).toEqual(wav);
  });

  it('reports API errors and empty speech plainly', async () => {
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    await expect(metaTranscribe(new Uint8Array(4), { apiKey: 'k', fetch: reply(400, { error: { message: 'audio too long' } }) })).rejects.toThrow(/400.*audio too long/);
    await expect(metaTranscribe(new Uint8Array(4), { apiKey: 'k', fetch: reply(200, { transcript: '  ', audioDurationMs: 900 }) })).rejects.toThrow(/no speech/i);
    await expect(metaTranscribe(new Uint8Array(4), { apiKey: '' })).rejects.toThrow(/META_MODEL_API_KEY/);
  });

  it('LATTICE_STT_MOCK answers with fixed text and no network', async () => {
    const t = transcriberFromEnv({ LATTICE_STT_MOCK: 'list the tracks' });
    expect(await t(new Uint8Array(4))).toMatchObject({ text: 'list the tracks', usd: 0 });
  });
});

describe('transcript and clip rules', () => {
  it('cleans spacing and doubled end punctuation', () => {
    expect(cleanTranscript('  make it   louder.. ')).toBe('make it louder.');
    expect(cleanTranscript('really?!')).toBe('really?!');
  });

  it('bills whole seconds at $0.18 per hour', () => {
    expect(sttCostUsd(3360)).toBeCloseTo((3 * 0.18) / 3600, 10);
    expect(sttCostUsd(900)).toBe(0);
  });

  it('drops taps and caps long holds', () => {
    expect(clipLength(0.2)).toBe('too short');
    expect(clipLength(2)).toBe('ok');
    expect(clipLength(31)).toBe('too long');
  });
});

describe('hold-to-talk key', () => {
  const ev = (code: string, extra: Partial<{ metaKey: boolean; tag: string }> = {}) => ({
    key: code === 'Backquote' ? '`' : 'x',
    code,
    shiftKey: false,
    metaKey: !!extra.metaKey,
    ctrlKey: false,
    altKey: false,
    target: extra.tag ? ({ tagName: extra.tag.toUpperCase(), isContentEditable: false } as unknown as EventTarget) : null,
  });
  it('is the backquote key, not while typing or with a modifier', () => {
    expect(isPushToTalkKey(ev('Backquote'))).toBe(true);
    expect(isPushToTalkKey(ev('KeyX'))).toBe(false);
    expect(isPushToTalkKey(ev('Backquote', { tag: 'textarea' }))).toBe(false);
    expect(isPushToTalkKey(ev('Backquote', { metaKey: true }))).toBe(false);
  });
});
