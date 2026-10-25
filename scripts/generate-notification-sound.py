"""Three playful strikes on an empty metal basin; pure Python synthesis."""
import math
import random
import wave
from array import array
from pathlib import Path

RATE = 48000
DURATION = 1.65
N = int(RATE * DURATION)
rng = random.Random(20261025)
dry = [0.0] * N
# A hand-held thin stainless food bowl: short hollow body, bright clattery rim.
# Suppress low sustained modes and slow beating that made the first version gong-like.
modes = [
    (423, .24, .022), (731, .34, .041), (1163, .40, .063),
    (1789, .49, .084), (2317, .38, .069), (3083, .31, .051),
    (3911, .25, .040), (4877, .17, .031), (6091, .11, .024),
    (7481, .07, .017), (8933, .04, .012),
]
# Dense, quickly damped upper modes give the attack a sheet-metal texture.
for _ in range(42):
    f = rng.uniform(1400, 11000)
    modes.append((f, rng.uniform(.012, .046), rng.uniform(.009, .031)))
for onset, strength, tuning in [(0.045, .95, 1.0), (.435, .92, 1.004), (.825, 1.04, .997)]:
    start = int(onset * RATE)
    count = min(int(.70 * RATE), N - start)
    hit = [0.0] * count
    for freq, amplitude, decay in modes:
        phase = rng.uniform(-.16, .16)
        for j in range(count):
            t = j / RATE
            attack = 1.0 - math.exp(-t / .00018)
            # No gong-like pitch sweep.
            bend = 0.0
            hit[j] += amplitude * attack * math.exp(-t / decay) * math.sin(2 * math.pi * freq * tuning * t + bend + phase)
    previous = 0.0
    for j in range(min(count, int(.055 * RATE))):
        t = j / RATE
        noise = rng.uniform(-1, 1)
        high = noise - previous
        previous = noise
        hit[j] += .48 * high * math.exp(-t / .0022) * (1 - math.exp(-t / .00010))
        hit[j] += .24 * math.sin(2 * math.pi * 760 * t) * math.exp(-t / .004)
    for j, value in enumerate(hit):
        dry[start + j] += value * strength

# Small early reflections, not a long room wash: notifications stay distinct.
left = dry.copy()
right = dry.copy()
for delay, gain, side in [(0.009, .035, left), (.012, .03, right)]:
    shift = int(delay * RATE)
    for j in range(shift, N):
        side[j] += dry[j - shift] * gain
peak = max(max(abs(x) for x in left), max(abs(x) for x in right))
gain = .84 / peak
frames = array('h')
for j in range(N):
    fade = min(1.0, (N - 1 - j) / (RATE * .06))
    frames.append(round(left[j] * gain * fade * 32767))
    frames.append(round(right[j] * gain * fade * 32767))
import sys
if sys.byteorder != 'little':
    frames.byteswap()
output = Path(__file__).resolve().parents[1] / 'outputs' / 'fish-basin-notification' / '大肥鱼饿了-不锈钢饭盆-v2.wav'
output.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(output), 'wb') as wav:
    wav.setnchannels(2)
    wav.setsampwidth(2)
    wav.setframerate(RATE)
    wav.writeframes(frames.tobytes())
with wave.open(str(output), 'rb') as wav:
    assert wav.getnframes() == N
    assert wav.getnchannels() == 2
    print(f'Created: {output.resolve()}')
    print(f'Validated: {wav.getnframes() / wav.getframerate():.2f}s, {wav.getframerate()} Hz, 16-bit stereo')
    print(f'Peak: {max(abs(v) for v in frames) / 32768:.3f}; strikes: 3; bytes: {output.stat().st_size}')
