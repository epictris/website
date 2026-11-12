"""v40: preserve preferred v39 variant 2; reduce bumps and residual ringing.

Offline auditions only. Run with tools/audio/.venv/bin/python tools/audio/refine-roll.py.
"""
from pathlib import Path
import json
import numpy as np
from scipy import signal, ndimage
import soundfile as sf
import audio

HERE = Path(__file__).resolve().parent
OUT = HERE/'out'
source = OUT/'roll-2-processed-v39/roll-2-processed-v39.wav'
x, sr = audio.read_audio(source)
x = x[:, 0]
# Detect short amplitude excursions relative to the surrounding 410 ms.
# Attenuate only: no gain boost of quiet/noisy sections and no sample shuffling.
hop = round(.005*sr)
power = ndimage.uniform_filter1d(x*x, size=round(.01*sr))
env = np.sqrt(np.maximum(power[::hop], 1e-20))
baseline = ndimage.median_filter(env, size=83, mode='nearest')
gain = np.minimum(1, (np.maximum(baseline, 1e-9)*1.25/env)**.9)
gain = np.maximum(gain, 10**(-15/20))
gain = ndimage.minimum_filter1d(gain, size=5, mode='nearest')
gain = ndimage.gaussian_filter1d(gain, sigma=1.5)
sample_gain = np.interp(np.arange(len(x)), np.arange(len(env))*hop, gain)
bumps = x*sample_gain

# Time-varying spectral suppression: target narrow peaks sustained for ~43 ms,
# keeping broadband grit and attacks. Max cut 12 dB; no blanket low-pass.
freq, times, z = signal.stft(bumps, sr, nperseg=4096, noverlap=3584)
power = np.abs(z)**2
floor = ndimage.median_filter(power, size=(21, 1), mode='nearest')
ratio = power/np.maximum(floor, 1e-18)
sustained = ndimage.median_filter(ratio, size=(1, 5), mode='nearest')
mask = np.ones_like(power)
eligible = (freq[:, None] > 1200) & (sustained > 3)
mask[eligible] = np.maximum(10**(-12/20), np.sqrt(2/sustained[eligible]))
mask = ndimage.minimum_filter1d(mask, size=3, axis=0)
mask = ndimage.gaussian_filter(mask, sigma=(.6, 1))
_, clean = signal.istft(z*mask, sr, nperseg=4096, noverlap=3584)
clean = clean[:len(x)]
items = [
    ('roll-1-preferred-reference-v40', x, 'Unchanged v39 variant 2; matched comparison gain.'),
    ('roll-2-bumps-reduced-v40', bumps, 'Short peaks attenuated against local 410 ms baseline; no pitch shift, shuffle or quiet-section boost.'),
    ('roll-3-bumps-and-ringing-reduced-v40', clean, 'Same peak reduction plus time-varying narrow resonance suppression above 1.2 kHz, capped at 12 dB.'),
]
def rms(y):
    return float(np.sqrt(np.mean(y*y)))
target = min(rms(x), *(10**(-3/20)*rms(y)/np.max(np.abs(y)) for _, y, _ in items))
manifest_path = OUT/'manifest.json'
manifest = json.loads(manifest_path.read_text())
reports = []
for name, y, note in items:
    directory = OUT/name
    directory.mkdir(parents=True, exist_ok=True)
    path = directory/f'{name}.wav'
    sf.write(path, y*target/rms(y), sr, subtype='PCM_24')
    report = audio.measure(path)
    assert report['samplesAtFullScale'] == 0 and np.isfinite(y).all()
    reports.append(report)
    audio.save_json(directory/'analysis.json', report)
    audio.save_json(directory/'source-edit.json', dict(source=str(source), sha256=audio.digest(source), note=note, comparisonGain=target/rms(y), builder='tools/audio/refine-roll.py', listeningVerified=False))
    audio.write_project(directory/f'{name}.rpp', [(name, path, len(y)/sr)], sr)
    manifest['candidates'] = [c for c in manifest['candidates'] if c['name'] != name]
    manifest['candidates'].append(dict(name=name, event='roll', slot='roll', slots=['roll'], file=f'{name}/{name}.wav', sha256=audio.digest(path), source=note, author='', license=''))
audio.save_json(manifest_path, manifest)
audio.save_json(OUT/'roll-refinement-v40.json', dict(reports=reports, maximumBumpAttenuationDb=audio.db(sample_gain.min()), note='User preferred v39 variant 2; reports bumps unrelated to game surface and intermittent high ringing. New auditions need listening; game unchanged.'))
for r in reports:
    print(Path(r['file']).name, 'RMS', r['rmsDbfs'], 'peak', r['peakDbfs'], 'crest', r['crestDb'])
