"""Replace only winding variation 3 with a fresh native-pitch source cut.

The 8.76944–8.88944 s transient has the closest broadband spectral balance
to variations 1/2 among separated energetic transients in the source. This
is a measurement-based selection awaiting listening, not a tonal repair.
"""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import audio

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
NAME = "wind-chain-heavy-3-v34"


def main():
    recipes_path = HERE / "recipes.json"
    recipes = json.loads(recipes_path.read_text())
    spec = copy.deepcopy(next(c for c in recipes["candidates"] if c["name"] == "wind-chain-heavy-1-v18"))
    spec["name"] = NAME
    spec["recordedLayers"][0].update(start=8.76944, end=8.88944)
    spec["source"] += "; replacement winding variation 3: 8.76944–8.88944 s, native pitch"
    recipes["candidates"] = [c for c in recipes["candidates"] if c["name"] != NAME] + [spec]
    audio.save_json(recipes_path, recipes)
    recipe_path = HERE / "wind-third-recipe.json"
    audio.save_json(recipe_path, dict(sampleRate=recipes["sampleRate"], seed=recipes["seed"], candidates=[spec]))
    manifest_path = HERE / "out/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    audio.render(recipe_path, HERE / "out")
    added = json.loads(manifest_path.read_text())["candidates"]
    manifest["candidates"] = [c for c in manifest["candidates"] if c["name"] != NAME] + added
    audio.save_json(manifest_path, manifest)
    wav = HERE / "out" / NAME / (NAME + ".wav")
    data = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(wav),
        "-c:a", "libopus", "-b:a", "128k", "-f", "ogg", "-fflags", "+bitexact", "-"])
    sha = hashlib.sha256(data).hexdigest()
    key = NAME + "-" + sha[:8]
    (ROOT / "public/sounds" / (key + ".ogg")).write_bytes(data)
    ap, bp = [ROOT / "src/audio" / name for name in ("soundAssets.json", "soundBank.json")]
    assets, bank = [json.loads(p.read_text()) for p in (ap, bp)]
    audio.save_json(HERE / "out/before-wind-v34.json", dict(assets=assets, bank=bank))
    old = bank["slots"]["wind"]["sounds"][2]
    assets[key] = dict(file=f"/sounds/{key}.ogg", sha256=sha, bytes=len(data),
        seconds=spec["seconds"], name=NAME + ".wav", source=spec["source"],
        author=spec["author"], license=spec["license"])
    bank["slots"]["wind"]["sounds"][2] = key
    # Same rendering peak as variation 1; retain its source calibration so the
    # replacement joins the two existing clicks at their established level.
    bank["clips"].pop(old, None)
    first = bank["slots"]["wind"]["sounds"][0]
    bank["clips"][key] = copy.deepcopy(bank["clips"].get(first, {}))
    if old != key and not any(old in s.get("sounds", []) for s in bank["slots"].values()):
        assets.pop(old, None)
    audio.save_json(ap, assets)
    audio.save_json(bp, bank)
    subprocess.run([str(HERE / ".venv/bin/python"), str(HERE / "seed-layer-projects.py")], check=True)
    print("Assigned", key)


if __name__ == "__main__":
    main()
