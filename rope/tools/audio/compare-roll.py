"""Build v39 rolling diagnostics and a conservative continuous-loop candidate.

Run from rope: tools/audio/.venv/bin/python tools/audio/compare-roll.py
No game assignments. Selection is measurement-based, not listening approval.
"""
from pathlib import Path
import json
import subprocess
import tempfile
import numpy as np
from scipy import signal
import soundfile as sf
import audio

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT = HERE / 'out'
original = HERE / 'sources/cannonball_rolls.m4a'
source, sr = audio.read_audio(original)
source = source.mean(axis=1)
raw = source[round(8.6 * sr):round(13.4 * sr)].copy()
bank = json.loads((ROOT / 'src/audio/soundBank.json').read_text())
assets = json.loads((ROOT / 'src/audio/soundAssets.json').read_text())
key = bank['slots']['roll']['sounds'][0] if 'slots' in bank else bank['events']['roll']['sounds'][0]
asset = ROOT / 'public' / assets[key]['file'].lstrip('/')
processed, rate = audio.read_audio(asset)
processed = processed.mean(axis=1)
if rate != sr:
    from fractions import Fraction
    ratio = Fraction(sr, rate)
    processed = signal.resample_poly(processed, ratio.numerator, ratio.denominator)
clip = bank.get('clips', {}).get(key, {})
processed = processed[round(clip.get('start', 0) * sr):round(clip.get('end', len(processed)/sr) * sr)]
assert clip.get('rate', 1) == 1, 'Review pitch settings before rendering'
with tempfile.TemporaryDirectory() as tmp:
    inp, out = Path(tmp)/'input.f32', Path(tmp)/'output.f32'
    processed.astype('<f4').tofile(inp)
    subprocess.run(['bun', str(HERE/'render-roll-texture.ts'), str(inp), str(out), str(sr), '4.8'], check=True)
    grains = np.fromfile(out, dtype='<f4')
# Steady reference-speed tone filter, matching WebAudio lowpass Q=sqrt(1/2).
# RBJ lowpass coefficients (WebAudio Q is expressed in dB).
w = 2*np.pi*14000/sr
alpha = np.sin(w)/(2 * 10**(np.sqrt(.5)/20))
b = np.array([(1-np.cos(w))/2, 1-np.cos(w), (1-np.cos(w))/2])/(1+alpha)
a = np.array([1+alpha, -2*np.cos(w), 1-alpha])/(1+alpha)
grains = signal.lfilter(b, a, grains)

# Rank 2-second windows within the same known rolling passage. Penalize
# abrupt level changes and exceptional peaks; this cannot detect semantic noise.
ranked = []
for start in np.arange(0, 2.801, .05):
    x = raw[round(start*sr):round((start+2)*sr)]
    frames = x[:len(x)//480*480].reshape(-1, 480)
    levels = np.sqrt(np.mean(frames**2, axis=1))
    score = float(np.std(np.log(np.maximum(levels, 1e-8))) + .1*np.max(np.abs(x))/np.sqrt(np.mean(x*x)))
    ranked.append((score, float(start)))
score, start = min(ranked)
candidate = raw[round(start*sr):round((start+2)*sr)].copy()
candidate = signal.sosfilt(signal.butter(2, 35, 'highpass', fs=sr, output='sos'), candidate)
# Periodic overlap-add with a 100 ms complementary crossfade, no grain shuffle.
n = round(.1*sr)
fade = np.linspace(0, 1, n)
seam = candidate[-n:]*(1-fade) + candidate[:n]*fade
candidate = np.concatenate([seam, candidate[n:-n]])
items = [
    ('roll-1-original-v39', raw, 'Original 8.6–13.4 s, mono; only comparison gain.'),
    ('roll-2-processed-v39', processed, 'Current assigned OGG decoded directly; same source passage.'),
    ('roll-3-granular-v39', grains, 'Production RollingTexture, seed 1729; steady 3 m/s tone filter; no spatialization or onset/release envelope.'),
    ('roll-4-continuous-v39', candidate, f'Original {8.6+start:.2f}–{10.6+start:.2f} s; 35 Hz highpass, 100 ms loop crossfade; measurement-selected, listening pending.'),
]
def rms(x):
    return float(np.sqrt(np.mean(x*x)))
target = min(10**(-24/20), *(10**(-3/20)*rms(x)/np.max(np.abs(x)) for _, x, _ in items))
manifest_path = OUT/'manifest.json'
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'candidates': []}
reports = []
for name, x, note in items:
    directory = OUT/name
    directory.mkdir(parents=True, exist_ok=True)
    path = directory/f'{name}.wav'
    gain = target/rms(x)
    sf.write(path, x*gain, sr, subtype='PCM_24')
    report = audio.measure(path)
    assert report['samplesAtFullScale'] == 0
    reports.append(report)
    audio.save_json(directory/'analysis.json', report)
    audio.save_json(directory/'source-edit.json', dict(original=str(original), originalSha256=audio.digest(original), assignedAsset=str(asset), assignedSha256=audio.digest(asset), gain=gain, note=note, selectionStart=8.6+start if name.endswith('continuous-v39') else None))
    audio.write_project(directory/f'{name}.rpp', [(name, path, len(x)/sr)], sr)
    manifest['candidates'] = [c for c in manifest['candidates'] if c['name'] != name]
    manifest['candidates'].append(dict(name=name, event='roll', slot='roll', slots=['roll'], file=f'{name}/{name}.wav', sha256=audio.digest(path), source=note, author='', license=''))
audio.save_json(manifest_path, manifest)
audio.save_json(OUT/'roll-comparison-v39.json', dict(targetRmsDbfs=audio.db(target), selection=dict(start=8.6+start, end=10.6+start, score=score), reports=reports, note='RMS matching, not perceptual loudness matching. No listening verification. Game assignments unchanged.'))
print(json.dumps({'targetRmsDbfs': audio.db(target), 'sourceWindow': [8.6+start, 10.6+start], 'files': [{k:r[k] for k in ['file','seconds','rmsDbfs','peakDbfs']} for r in reports]}, indent=2))
