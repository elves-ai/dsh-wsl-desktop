import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Approved source bytes are pinned here; the tests need only bundled assets, not outputs/.
const voices = [
  { name: 'completed', sha256: '348d633480fbf44b3227cd17e435569d425411c6ae7c66dccf5e365a4d5c68c5', duration: 1.70 },
  { name: 'failed', sha256: '69126a2a45dd5b67fe983ccabd398c629aea6d09a0fd6560b80ba865b32182c9', duration: 2.32 },
  { name: 'waiting', sha256: '30b8b1816a4c208af41f6fb3018d8139755abfb7a16f0d098e1c7aa92a22b515', duration: 2.32 },
];

function chunks(wav) {
  const result = new Map();
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4) + 8, wav.length);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  let offset = 12;
  while (offset < wav.length) {
    assert.ok(offset + 8 <= wav.length, 'complete chunk header');
    const size = wav.readUInt32LE(offset + 4);
    assert.ok(offset + 8 + size <= wav.length, 'complete chunk payload');
    const name = wav.toString('ascii', offset, offset + 4);
    assert.ok(!result.has(name), 'no duplicate WAV chunks');
    result.set(name, wav.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  assert.equal(offset, wav.length, 'complete chunk padding');
  return result;
}

for (const voice of voices) {
  const wav = readFileSync(new URL(`../src-tauri/src/assets/notification-${voice.name}.wav`, import.meta.url));

  test(`bundled ${voice.name} voice is exactly the approved PCM16 24kHz mono WAV`, () => {
    assert.equal(createHash('sha256').update(wav).digest('hex'), voice.sha256);
    const parts = chunks(wav);
    const fmt = parts.get('fmt ');
    assert.ok(fmt && fmt.length >= 16, 'complete PCM format');
    assert.equal(fmt.readUInt16LE(0), 1, 'uncompressed PCM needs no codec');
    assert.equal(fmt.readUInt16LE(2), 1, 'mono');
    assert.equal(fmt.readUInt32LE(4), 24000, '24kHz sample rate');
    assert.equal(fmt.readUInt32LE(8), 48000, 'PCM byte rate');
    assert.equal(fmt.readUInt16LE(12), 2, 'PCM block alignment');
    assert.equal(fmt.readUInt16LE(14), 16, '16-bit samples');
    const data = parts.get('data');
    assert.ok(data && data.length > 0, 'nonempty audio data');
    assert.equal(data.length % 2, 0, 'complete PCM samples');
    assert.equal(data.length / 48000, voice.duration, 'approved duration in seconds');
  });

  test(`bundled ${voice.name} voice is audible, quiet and has zero endpoints`, () => {
    const data = chunks(wav).get('data');
    assert.ok(data && data.length >= 2 && data.length % 2 === 0, 'complete nonempty PCM data');
    let peak = 0;
    let energy = 0;
    for (let i = 0; i < data.length; i += 2) {
      const sample = data.readInt16LE(i) / 32768;
      peak = Math.max(peak, Math.abs(sample));
      energy += sample ** 2;
    }
    assert.ok(peak <= .301, 'quiet peak with no clipping');
    assert.ok(energy > 0, 'nonzero effective audio signal');
    assert.equal(data.readInt16LE(0), 0, 'no start click');
    assert.equal(data.readInt16LE(data.length - 2), 0, 'no end click');
  });
}
