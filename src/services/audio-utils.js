'use strict';

const DEFAULT_SAMPLE_RATE = 16000;
const MAX_PCM_BYTES = 24 * 1024 * 1024;

function decodeFloat32Base64(value, maxBytes = MAX_PCM_BYTES) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Audio payload is empty.');
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length) throw new Error('Audio payload could not be decoded.');
  if (buffer.length > maxBytes) throw new Error('Audio recording is too large; keep a take under two minutes.');
  if (buffer.length % 4 !== 0) throw new Error('Audio payload is not aligned float32 PCM.');
  return buffer;
}

function analyzeFloat32Pcm(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return { samples: 0, peak: 0, rms: 0, duration: 0 };
  }
  let peak = 0;
  let sumSquares = 0;
  let valid = 0;
  for (let offset = 0; offset + 4 <= buffer.length; offset += 4) {
    const sample = buffer.readFloatLE(offset);
    if (!Number.isFinite(sample)) continue;
    const clipped = Math.max(-1, Math.min(1, sample));
    const magnitude = Math.abs(clipped);
    if (magnitude > peak) peak = magnitude;
    sumSquares += clipped * clipped;
    valid += 1;
  }
  return {
    samples: valid,
    peak,
    rms: valid ? Math.sqrt(sumSquares / valid) : 0,
    duration: valid / DEFAULT_SAMPLE_RATE
  };
}

function hasAudibleSignal(stats) {
  return Boolean(stats && stats.samples >= DEFAULT_SAMPLE_RATE / 4 && stats.peak >= 0.004 && stats.rms >= 0.00045);
}

function float32PcmToWav(buffer, sampleRate = DEFAULT_SAMPLE_RATE) {
  if (!Buffer.isBuffer(buffer) || buffer.length % 4 !== 0) {
    throw new Error('Expected little-endian float32 PCM.');
  }
  const samples = buffer.length / 4;
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataBytes = samples * blockAlign;
  const wav = Buffer.allocUnsafe(44 + dataBytes);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM integer
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);

  let out = 44;
  for (let offset = 0; offset < buffer.length; offset += 4) {
    const value = buffer.readFloatLE(offset);
    const clipped = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    wav.writeInt16LE(clipped < 0 ? Math.round(clipped * 32768) : Math.round(clipped * 32767), out);
    out += 2;
  }
  return wav;
}

module.exports = {
  DEFAULT_SAMPLE_RATE,
  MAX_PCM_BYTES,
  decodeFloat32Base64,
  analyzeFloat32Pcm,
  hasAudibleSignal,
  float32PcmToWav
};
