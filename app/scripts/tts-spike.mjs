// B14 spike: Meta's MMS-TTS English (facebook/mms-tts-eng, VITS; ONNX build Xenova/mms-tts-eng)
// through the Transformers.js text-to-speech pipeline, fp32. Writes WAVs of five typical Muse
// confirmations to out/tts-spike/ (git-ignored) and prints load time and time per phrase.
// Weights (CC BY-NC 4.0) download once to the Transformers.js cache (node_modules, git-ignored).
// Run from app/: node scripts/tts-spike.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from '@huggingface/transformers';
import { speakable } from '../src/core/voiceTools.ts'; // numbers in words, as the app says them (Node 22.18+ strips types)

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'out', 'tts-spike');
const PHRASES = [
  'Panned the double 30 percent right.',
  'Moved the vocal up two bars.',
  'Brighter how: raise the top end, or cut the low mids?',
  'Quantized the drums to sixteenths.',
  'Added a compressor to the bass.',
];

function wav16(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((x, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x)) * 32767), 44 + i * 2));
  return buf;
}

mkdirSync(OUT, { recursive: true });
let t = performance.now();
const synth = await pipeline('text-to-speech', 'Xenova/mms-tts-eng', { dtype: 'fp32' });
console.log(`model load: ${Math.round(performance.now() - t)} ms`);
for (const [i, text] of PHRASES.entries()) {
  t = performance.now();
  const out = await synth(speakable(text));
  const ms = Math.round(performance.now() - t);
  const secs = out.audio.length / out.sampling_rate;
  const file = join(OUT, `${i + 1}.wav`);
  writeFileSync(file, wav16(out.audio, out.sampling_rate));
  console.log(`${ms} ms for ${secs.toFixed(2)} s of audio (${out.sampling_rate} Hz): "${text}" -> out/tts-spike/${i + 1}.wav`);
}
