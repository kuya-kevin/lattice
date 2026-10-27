// Generates the tiny sound-library fixture used by tests (synthetic audio, made-up metadata).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.argv[2];
function wav(path, seconds, hz, kind = 'sine', sr = 8000) {
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    const env = Math.exp((-4 * i) / n);
    let v;
    if (kind === 'noise') { seed = (seed * 16807) % 2147483647; v = (seed / 2147483647) * 2 - 1; }
    else v = Math.sin((2 * Math.PI * hz * i) / sr);
    b.writeInt16LE(Math.round(v * env * 9000), 44 + i * 2);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, b);
}
const fs = [
  { id: 101, category: 'synth_lead', kind: 'pitched', name: 'Fixture Lead A', tags: ['Lead', 'Synth', 'Note'], license: 'http://creativecommons.org/publicdomain/zero/1.0/', license_name: 'CC0-1.0', username: 'fixture_user', url: 'https://freesound.org/people/fixture_user/sounds/101/', duration: 0.8, fs_note_name: 'A3', hz: 220 },
  { id: 102, category: 'synth_bass', kind: 'pitched', name: 'Fixture Sub Bass', tags: ['Bass', 'Synth'], license: 'http://creativecommons.org/licenses/by/4.0/', license_name: 'CC-BY-4.0', username: 'bass_maker', url: 'https://freesound.org/people/bass_maker/sounds/102/', duration: 1.0, fs_note_name: 'E1', hz: 55 },
  { id: 103, category: 'kick', kind: 'drum', name: 'Fixture Kick', tags: ['kick', 'drums', 'one-shot'], license: 'http://creativecommons.org/licenses/by/3.0/', license_name: 'CC-BY-3.0', username: 'drummer', url: 'https://freesound.org/people/drummer/sounds/103/', duration: 0.4, hz: 60 },
  { id: 104, category: 'closed_hat', kind: 'drum', name: 'Fixture Hat', tags: ['hihat', 'drums'], license: 'http://creativecommons.org/publicdomain/zero/1.0/', license_name: 'CC0-1.0', username: 'drummer', url: 'https://freesound.org/people/drummer/sounds/104/', duration: 0.2, noise: true },
];
const mat = [
  { id: 201, category: 'dry_vocal', name: 'Fixture Dry Vocal Phrase', tags: ['vocal', 'singing', 'dry'], license: 'http://creativecommons.org/licenses/by/4.0/', license_name: 'CC-BY-4.0', username: 'singer', url: 'https://freesound.org/people/singer/sounds/201/', duration: 4.0, hz: 330 },
  { id: 202, category: 'drum_loop_live', name: 'Fixture Live Drum Loop', tags: ['drums', 'loop'], license: 'http://creativecommons.org/publicdomain/zero/1.0/', license_name: 'CC0-1.0', username: 'drummer', url: 'https://freesound.org/people/drummer/sounds/202/', duration: 4.0, fs_bpm: 120, noise: true },
];
const write = (dir, list) => {
  const out = list.map(({ hz, noise, ...e }) => {
    const rel = `data/${dir}/audio/${e.category}/${e.id}.wav`;
    wav(join(root, dir, 'audio', e.category, `${e.id}.wav`), e.duration, hz ?? 0, noise ? 'noise' : 'sine');
    return { ...e, description: `Synthetic test fixture (${e.category}).`, wav: rel };
  });
  writeFileSync(join(root, dir, 'manifest.json'), JSON.stringify(out, null, 1));
};
write('freesound', fs);
write('freesound_material', mat);
wav(join(root, 'voice_notes', 'new_recording_900.wav'), 3.0, 262);
writeFileSync(join(root, 'README.md'), '# Library test fixture\n\nTiny synthetic sounds with made-up metadata in the same layout as `data/` (manifests + voice notes), so tests never touch the big data drive. Regenerate with `node scripts/make-library-fixture.mjs tests/fixtures/library`.\n');
