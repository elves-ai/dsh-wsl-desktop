import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const wav = readFileSync(new URL('../src-tauri/src/assets/notification-basin.wav', import.meta.url));

function chunks() {
  const result = new Map();
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4) + 8, wav.length);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  let offset = 12;
  while (offset < wav.length) {
    assert.ok(offset + 8 <= wav.length, 'complete chunk header');
    const size = wav.readUInt32LE(offset + 4);
    assert.ok(offset + 8 + size <= wav.length, 'complete chunk payload');
    result.set(wav.toString('ascii', offset, offset + 4), wav.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  return result;
}

test('bundled notification is exactly the approved stainless bowl v2, in native PCM WAV format', () => {
  assert.equal(createHash('sha256').update(wav).digest('hex'), '3be00932d291fe1a268e54ebf891bb8fa15c0cc956a1955a111551ba0a0aa38a');
  const parts = chunks();
  const fmt = parts.get('fmt ');
  assert.ok(fmt);
  assert.equal(fmt.readUInt16LE(0), 1, 'uncompressed PCM needs no codec');
  assert.equal(fmt.readUInt16LE(2), 2);
  assert.equal(fmt.readUInt32LE(4), 48000);
  assert.equal(fmt.readUInt32LE(8), 192000);
  assert.equal(fmt.readUInt16LE(12), 4);
  assert.equal(fmt.readUInt16LE(14), 16);
  assert.equal(parts.get('data').length / 192000, 1.65);
});

test('notification has three separate short strikes and an unclipped, quiet ending', () => {
  const data = chunks().get('data');
  function rms(start, end) {
    const first = Math.round(start * 48000) * 4;
    const last = Math.round(end * 48000) * 4;
    let energy = 0;
    for (let i = first; i < last; i += 2) energy += (data.readInt16LE(i) / 32768) ** 2;
    return Math.sqrt(energy / ((last - first) / 2));
  }
  assert.equal(rms(0, .04), 0, 'no click before the first strike');
  for (const onset of [.045, .435, .825]) {
    const attack = rms(onset, onset + .04);
    assert.ok(attack > .06, 'audible attack');
    assert.ok(rms(onset + .27, onset + .36) < attack * .04, 'short decay before next strike');
  }
  assert.equal(rms(1.55, 1.65), 0, 'no truncated ringing or end click');
  let peak = 0;
  for (let i = 0; i < data.length; i += 2) peak = Math.max(peak, Math.abs(data.readInt16LE(i)));
  assert.ok(peak > 25000 && peak < 30000, 'headroom without clipping');
});
