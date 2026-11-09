"""Remove narrow source resonances while preserving broadband rolling detail."""
from pathlib import Path
import json
import numpy as np
from scipy import signal, ndimage
import soundfile as sf
import audio

HERE = Path(__file__).resolve().parent
source = HERE / 'sources/cannonball_rolls.m4a'
x, sr = audio.read_audio(source)
x = x[round(8.6 * sr):round(13.4 * sr)].mean(axis=1)
nfft = 4096
freq, times, spectrum = signal.stft(x, sr, nperseg=nfft, noverlap=3072)
power = np.mean(np.abs(spectrum) ** 2, axis=1)
# A robust local spectral floor separates narrow metallic modes from the
# broad contact texture. No low-pass blanket over the upper frequencies.
floor = ndimage.median_filter(power, size=31, mode='nearest')
ratio = power / np.maximum(floor, 1e-18)
mask = np.ones_like(power)
tonal = (freq > 450) & (ratio > 2)
mask[tonal] = np.maximum(.015, np.sqrt(.5 / ratio[tonal]))
# Expand each detected mode slightly so sidebands and frequency drift are
# reduced too, with a smooth boundary rather than an abrupt spectral cut.
mask = ndimage.minimum_filter1d(mask, size=3)
mask = ndimage.gaussian_filter1d(mask, sigma=.65)
_, cleaned = signal.istft(spectrum * mask[:, None], sr, nperseg=nfft, noverlap=3072)
cleaned = cleaned[:len(x)]
# Retain the original broadband level; later grain RMS compensation is bounded.
path = HERE / 'sources/cannonball-roll-dry-v25.wav'
sf.write(path, cleaned, sr, subtype='FLOAT')
metadata = dict(name=path.name, file=path.name, originalName=source.name,
    sha256=audio.digest(path), source='User-provided download: cannonball_rolls.m4a (8.6–13.4 s; narrow tonal resonance reduction)', author='', license='')
library = json.loads((HERE / 'local-sources.json').read_text())
library = [s for s in library if s['file'] != path.name] + [metadata]
audio.save_json(HERE / 'local-sources.json', library)
peaks, _ = signal.find_peaks(ratio, height=4, distance=6)
report = dict(original=source.name, originalSha256=audio.digest(source), start=8.6, end=13.4,
    fft=nfft, hop=1024, localMedianBins=31, targetPowerRatio=.5,
    output=path.name, outputSha256=audio.digest(path),
    modes=[dict(hz=round(float(freq[i]),1), reductionDb=audio.db(mask[i])) for i in peaks if freq[i]>450],
    note='Spectral measurements only; subjective absence of ringing requires listening.')
audio.save_json(HERE / 'sources/cannonball-roll-dry-v25.source.json', report)
print(json.dumps(report, indent=2))
