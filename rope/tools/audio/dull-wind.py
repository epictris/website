"""Render all three chosen winding cuts with a 6 kHz low-pass at native pitch.

Keep the replacement source window for variation 3 and preserve game controls.
"""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import audio

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def main():
    rp = HERE / "recipes.json"
    recipes = json.loads(rp.read_text())
    specs = []
    for i, version in [(1, "v18"), (2, "v18"), (3, "v34")]:
        spec = copy.deepcopy(next(c for c in recipes["candidates"]
            if c["name"] == f"wind-chain-heavy-{i}-{version}"))
        spec["name"] = f"wind-chain-dull-{i}-v36"
        spec["recordedLayers"][0]["lowpass"] = 6000
        spec["source"] += "; v36 6 kHz low-pass, native pitch"
        specs.append(spec)
    names = {s["name"] for s in specs}
    recipes["candidates"] = [c for c in recipes["candidates"] if c["name"] not in names] + specs
    audio.save_json(rp, recipes)
    recipe_path = HERE / "wind-dull-recipe.json"
    audio.save_json(recipe_path, dict(sampleRate=recipes["sampleRate"], seed=recipes["seed"], candidates=specs))
    mp = HERE / "out/manifest.json"
    manifest = json.loads(mp.read_text())
    audio.render(recipe_path, HERE / "out")
    manifest["candidates"] = [c for c in manifest["candidates"] if c["name"] not in names] + json.loads(mp.read_text())["candidates"]
    audio.save_json(mp, manifest)
    ap, bp = [ROOT / "src/audio" / n for n in ("soundAssets.json", "soundBank.json")]
    assets, bank = [json.loads(p.read_text()) for p in (ap, bp)]
    audio.save_json(HERE / "out/before-wind-v36.json", dict(assets=assets, bank=bank))
    previous = bank["slots"]["wind"]["sounds"][:]
    for i, spec in enumerate(specs):
        name = spec["name"]
        wav = HERE / "out" / name / (name + ".wav")
        data = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(wav),
            "-c:a", "libopus", "-b:a", "128k", "-f", "ogg", "-fflags", "+bitexact", "-"])
        sha = hashlib.sha256(data).hexdigest()
        key = name + "-" + sha[:8]
        (ROOT / "public/sounds" / (key + ".ogg")).write_bytes(data)
        assets[key] = dict(file=f"/sounds/{key}.ogg", sha256=sha, bytes=len(data),
            seconds=spec["seconds"], name=name + ".wav", source=spec["source"],
            author=spec["author"], license=spec["license"])
        old = previous[i]
        edit = bank["clips"].pop(old, {})
        bank["clips"][key] = edit
        bank["slots"]["wind"]["sounds"][i] = key
    assigned = {k for s in bank["slots"].values() for k in s.get("sounds", [])}
    for old in set(previous) - assigned:
        assets.pop(old, None)
    audio.save_json(ap, assets)
    audio.save_json(bp, bank)
    subprocess.run([str(HERE / ".venv/bin/python"), str(HERE / "seed-layer-projects.py")], check=True)
    print("Assigned", bank["slots"]["wind"]["sounds"])


if __name__ == "__main__":
    main()
