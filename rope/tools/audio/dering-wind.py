"""Build and assign a v33 dry third winding click from its archived v18 WAV.

Only variation 3 rings according to listening feedback. Variations 1 and 2
retain their original recordings and must not be processed.

Preserve the main click and its next 4 ms verbatim, blend into narrow resonance cuts over the
next 4 ms, then damp the remaining tail with a 20 ms time constant. Native
pitch, clip length, event controls and per-variation volume are retained.
"""
from pathlib import Path
import hashlib
import json
import subprocess

import numpy as np
from scipy import ndimage, signal
import soundfile as sf
import audio

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def main():
    ap, bp = [ROOT / "src/audio" / name for name in ("soundAssets.json", "soundBank.json")]
    assets, bank = [json.loads(p.read_text()) for p in (ap, bp)]
    audio.save_json(HERE / "out/before-wind-v33.json", {"assets": assets, "bank": bank})
    manifest_path = HERE / "out/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    catalog_path = HERE / "layer-projects.json"
    catalog = json.loads(catalog_path.read_text())
    manifest["candidates"] = [c for c in manifest["candidates"] if not c["name"].startswith("wind-dry-")]
    keys, report = [], []
    for i, old_key in enumerate(bank["slots"]["wind"]["sounds"], 1):
        if i < 3:
            assert old_key.startswith(f"wind-chain-heavy-{i}-v18-"), "Restore original variations 1 and 2 first"
            keys.append(old_key)
            continue
        # Always derive from the lossless original, including on a repeat build.
        original = f"wind-chain-heavy-{i}-v18"
        source = HERE / "out" / original / (original + ".wav")
        x, sr = sf.read(source)
        f, power = signal.periodogram(x[round(.008 * sr):round(.1 * sr)], sr, nfft=8192)
        floor = ndimage.median_filter(power, size=81)
        ratio = power / np.maximum(floor, 1e-18)
        peaks, _ = signal.find_peaks(power, distance=40)
        peaks = sorted((p for p in peaks if 500 < f[p] < 12000 and ratio[p] > 4),
                       key=lambda p: power[p], reverse=True)[:5]
        filtered = x.copy()
        for p in peaks:
            b, a = signal.iirnotch(float(f[p]), 12, fs=sr)
            filtered = signal.lfilter(b, a, filtered)
        t = np.arange(len(x)) / sr
        click = float(np.argmax(np.abs(x))) / sr
        blend = np.clip((t - click - .004) / .004, 0, 1)
        y = (x * (1 - blend) + filtered * blend) * np.exp(-np.maximum(t - click - .008, 0) / .020)
        assert np.array_equal(x[:round((click + .004) * sr)], y[:round((click + .004) * sr)])
        assert np.max(np.abs(y)) < 1 and np.isfinite(y).all()
        name = f"wind-dry-{i}-v33"
        out = HERE / "out" / name
        out.mkdir(exist_ok=True)
        wav = out / (name + ".wav")
        sf.write(wav, y, sr, subtype="FLOAT")
        data = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(wav),
            "-c:a", "libopus", "-b:a", "128k", "-f", "ogg", "-fflags", "+bitexact", "-"])
        sha = hashlib.sha256(data).hexdigest()
        key = name + "-" + sha[:8]
        (ROOT / "public/sounds" / (key + ".ogg")).write_bytes(data)
        old = assets[old_key]
        provenance = old["source"].split("; v33")[0] + "; v33 narrow resonance cuts and 20 ms tail damping; original click attack/native pitch"
        assets[key] = {**old, "file": f"/sounds/{key}.ogg", "name": name + ".wav",
                       "bytes": len(data), "sha256": sha, "seconds": len(y) / sr, "source": provenance}
        # The mixer has a separate project catalog. Its source is the processed
        # lossless WAV because its browser effects cannot reproduce these notches.
        source_id = f"source-{name}"
        project_id = f"wind--{key}"
        catalog["sources"] = [s for s in catalog["sources"] if s["id"] != source_id]
        catalog["sources"].append(dict(id=source_id, name=name + ".wav",
            file=f"out/{name}/{name}.wav", seconds=len(y) / sr,
            source=provenance, author=old["author"], license=old["license"]))
        if not any(p["id"] == project_id for p in catalog["projects"]):
            effects = dict(gainDb=0, pitch=0, pan=0, highpass=0, lowpass=20000,
                bass=0, treble=0, fadeIn=0, fadeOut=0, decay=0, normalize=False,
                drive=0, delay=.15, delayMix=0, reverb=0, compression=0)
            catalog["projects"].append(dict(id=project_id, name=name, slot="wind",
                assetKey=key, seconds=len(y) / sr, loop=False, gainDb=0, fadeOut=0,
                layers=[dict(id="layer-1", name="Damped click (processed v18 recording)",
                    sourceId=source_id, clips=[dict(id="clip-1", start=0,
                        end=len(y) / sr, at=0, pitch=0, gain=1)],
                    effects=effects, mute=False, solo=False)]))
        if old_key in bank.get("clips", {}):
            bank["clips"][key] = bank["clips"].pop(old_key)
        keys.append(key)
        manifest["candidates"].append(dict(name=name, event="wind", slot="wind", slots=["wind"],
            file=f"{name}/{name}.wav", sha256=audio.digest(wav), source=provenance,
            author=old["author"], license=old["license"]))
        report.append(dict(name=name, original=original, originalSha256=audio.digest(source),
            notchHz=[round(float(f[p]), 2) for p in peaks], notchQ=12,
            clickMs=round(click * 1000, 2), preservedAttackMs=4, blendEndMs=8, decayMs=20,
            tailReductionDb=round(audio.db(np.linalg.norm(y[round((click+.02)*sr):]) / np.linalg.norm(x[round((click+.02)*sr):])), 2),
            peakDb=audio.db(np.max(np.abs(y)))))
    previous = bank["slots"]["wind"]["sounds"]
    bank["slots"]["wind"]["sounds"] = keys
    assigned = {k for slot in bank["slots"].values() for k in slot.get("sounds", [])}
    for key in set(previous) - assigned - set(keys):
        # Keep original files in out/ and leave shipping files available for open tabs.
        assets.pop(key, None)
    audio.save_json(ap, assets)
    audio.save_json(bp, bank)
    audio.save_json(manifest_path, manifest)
    audio.save_json(catalog_path, catalog)
    audio.save_json(HERE / "wind-dry-v33.json", report)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
