"""Cut three wet movement snippets for Hook dragging / Vine at native pitch."""
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
STARTS = [4.75, 12.0, 15.25]


def main():
    source = HERE / "sources/wet_movement.m4a"
    if not source.exists():
        shutil.copyfile(Path.home() / "Downloads/wet_movement.m4a", source)
    provenance = "User-provided download: wet_movement.m4a"
    metadata_path = HERE / "local-sources.json"
    metadata = json.loads(metadata_path.read_text())
    metadata = [s for s in metadata if s["file"] != source.name]
    metadata.append(dict(name=source.name, file=source.name, originalName=source.name,
        sha256=audio.digest(source), source=provenance, author="", license=""))
    audio.save_json(metadata_path, metadata)
    x, sr = audio.read_audio(source)
    mono = x.mean(axis=1)
    specs = []
    for i, start in enumerate(STARTS, 1):
        end = start + .75
        spec = dict(name=f"vine-slide-wet-{i}-v38", event="hook-drag", slot="hook-drag.vine", loop=True,
            seconds=end-start, recordedLayers=[dict(name="Wet vine slide",
                file="sources/wet_movement.m4a", start=start, end=end, pitch=0,
                duration=end-start, fadeIn=.015, fadeOut=.025, normalize=True, gain=1)],
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
    recipe_path = HERE / "vine-slide-recipe.json"
    audio.save_json(recipe_path, dict(sampleRate=sr, seed=1729, candidates=specs))
    mp = HERE / "out/manifest.json"
    manifest = json.loads(mp.read_text())
    audio.render(recipe_path, HERE / "out")
    manifest["candidates"] = [c for c in manifest["candidates"] if c["name"] not in names] + json.loads(mp.read_text())["candidates"]
    audio.save_json(mp, manifest)
    ap, bp = [ROOT / "src/audio" / n for n in ("soundAssets.json", "soundBank.json")]
    assets, bank = [json.loads(p.read_text()) for p in (ap, bp)]
    audio.save_json(HERE / "out/before-vine-slide-v38.json", dict(assets=assets, bank=bank))
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
    bank["slots"]["hook-drag.vine"] = {**copy.deepcopy(bank["slots"]["hook-drag"]),
        **bank["slots"].get("hook-drag.vine", {}), "sounds": keys, "pitchJitter": 0, "refSpeed": .25}
    audio.save_json(ap, assets)
    audio.save_json(bp, bank)
    subprocess.run([str(HERE / ".venv/bin/python"), str(HERE / "seed-layer-projects.py")], check=True)
    print("Assigned three wet snippets to hook-drag.vine")


if __name__ == "__main__":
    main()
