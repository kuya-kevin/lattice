// [S3 midi] Minimal WAV encoder: mono 16-bit PCM (channels are averaged). Used to hand a
// source's audio to the Python sidecar, which only needs the signal, not the stereo image.
export function encodeWavMono(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const n = channels[0]?.length ?? 0;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const text = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, n * 2, true);
  const k = channels.length || 1;
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (const ch of channels) x += ch[i];
    x = Math.max(-1, Math.min(1, x / k));
    v.setInt16(44 + i * 2, Math.round(x * 32767), true);
  }
  return buf;
}
