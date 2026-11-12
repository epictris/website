"""Cut the six wet_impacts.m4a hits for Attach / Vine at native pitch."""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import numpy as np
from scipy import ndimage
import audio

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PEAKS = [.1319, .7554, 1.3870, 2.2217, 3.0234, 3.7558]


def main():
    source = HERE / "sources/wet_impacts.m4a"
    if not source.exists():
        shutil.copyfile(Path.home() / "Downloads/wet_impacts.m4a", source)
    provenance = "User-provided download: wet_impacts.m4a"
    metadata_path = HERE / "local-sources.json"
    metadata = json.loads(metadata_path.read_text())
    metadata = [s for s in metadata if s["file"] != source.name]
    metadata.append(dict(name=source.name, file=source.name, originalName=source.name,
        sha256=audio.digest(source), source=provenance, author="", license=""))
    audio.save_json(metadata_path, metadata)
    x, sr = audio.read_audio(source)
    mono = x.mean(axis=1)
    envelope = np.sqrt(ndimage.uniform_filter1d(mono * mono, size=round(.003 * sr)))
    specs = []
    for i, peak in enumerate(PEAKS, 1):
        at = round(peak * sr)
        # Find the onset before the peak, preserving 2 ms of lead-in. Bound
        # each cut to one isolated hit, retaining its natural short wet tail.
        lo = max(0, at - round(.10 * sr))
        active = np.flatnonzero(envelope[lo:at] > envelope[at] * .04)
        start = max(0, (lo + int(active[0])) / sr - .002) if len(active) else peak - .02
        end = min(len(mono) / sr, peak + .30)
        spec = dict(name=f"vine-grab-wet-{i}-v37", event="attach", slot="attach.vine",
            seconds=end-start, recordedLayers=[dict(name="Wet vine grab",
                file="sources/wet_impacts.m4a", start=start, end=end, pitch=0,
                duration=end-start, fadeIn=.0005, fadeOut=.025, normalize=True, gain=1)],
            source=f"{provenance} ({start:.5f}–{end:.5f} s; native pitch)", author="", license="")
        layers, _ = audio.recorded_layers(spec, HERE / "recipes.json", sr, round(spec["seconds"] * sr))
        y = sum(layers)
        y *= 10 ** (-3 / 20) / max(np.max(np.abs(y)), 1e-12)
        power = np.convolve(y*y, np.ones(round(.05*sr))/round(.05*sr), mode="valid")
        spec["outputGainDb"] = float(-20 - 10*np.log10(max(np.max(power), 1e-18)))
        specs.append(spec)
    rp = HERE / "recipes.json"
    recipes = json.loads(rp.read_text())
    names = {s["name"] for s in specs}
    recipes["candidates"] = [s for s in recipes["candidates"] if s["name"] not in names] + specs
    audio.save_json(rp, recipes)
    recipe_path = HERE / "vine-grab-recipe.json"
    audio.save_json(recipe_path, dict(sampleRate=sr, seed=1729, candidates=specs))
    mp = HERE / "out/manifest.json"
    manifest = json.loads(mp.read_text())
    audio.render(recipe_path, HERE / "out")
    manifest["candidates"] = [c for c in manifest["candidates"] if c["name"] not in names] + json.loads(mp.read_text())["candidates"]
    audio.save_json(mp, manifest)
    ap, bp = [ROOT / "src/audio" / n for n in ("soundAssets.json", "soundBank.json")]
    assets, bank = [json.loads(p.read_text()) for p in (ap, bp)]
    audio.save_json(HERE / "out/before-vine-grab-v37.json", dict(assets=assets, bank=bank))
    keys = []
    for spec in specs:
        name = spec["name"]
        wav = HERE / "out" / name / (name + ".wav")
        data = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(wav),
            "-c:a", "libopus", "-b:a", "128k", "-f", "ogg", "-fflags", "+bitexact", "-"])
        sha = hashlib.sha256(data).hexdigest()
        key = name + "-" + sha[:8]
        (ROOT / "public/sounds" / (key + ".ogg")).write_bytes(data)
        assets[key] = dict(file=f"/sounds/{key}.ogg", sha256=sha, bytes=len(data),
            seconds=spec["seconds"], name=name + ".wav", source=spec["source"], author="", license="")
        keys.append(key)
    bank["slots"]["attach.vine"] = {**copy.deepcopy(bank["slots"]["attach"]),
        **bank["slots"].get("attach.vine", {}), "sounds": keys, "pitchJitter": 0}
    audio.save_json(ap, assets)
    audio.save_json(bp, bank)
    subprocess.run([str(HERE / ".venv/bin/python"), str(HERE / "seed-layer-projects.py")], check=True)
    print("Assigned six wet impacts to attach.vine")


if __name__ == "__main__":
    main()
