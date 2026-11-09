"""Extract short native-pitch collision and articulation variations.
Run with tools/audio/.venv/bin/python. Original source files remain untouched.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SR = 48000


def extract(filename, count):
    x = np.frombuffer(subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(HERE / "sources" / filename),
        "-af", "highpass=f=400", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]), dtype=np.float32).copy()
    width = 96
    energy = np.array([np.mean(x[i:i + width] ** 2) for i in range(0, len(x), width)])
    chosen = []
    # Separate attacks rather than adjacent chunks of one sustained rattle.
    for index in np.argsort(energy)[::-1]:
        t = int(index * width)
        if t < 96 or t + 2160 >= len(x): continue
        if any(abs(t - old) < SR * 0.065 for old in chosen): continue
        if energy[index] < energy.max() * 0.015: continue
        chosen.append(t)
        if len(chosen) == count: break
    for peak in sorted(chosen):
        start = peak - 96
        cut = x[start:start + 2400].copy()
        # 50 ms gestures, with most decay inside the sample and a complete
        # faded tail. No pitch shift or long recorded settling performance.
        cut[:48] *= np.linspace(0, 1, 48)
        cut[480:] *= np.linspace(1, 0, len(cut) - 480) ** 1.5
        cut *= 10 ** (-18 / 20) / max(np.max(abs(cut)), 1e-9)
        yield cut.astype(np.float32), start / SR


def main():
    ap = ROOT / "src/audio/soundAssets.json"
    bp = ROOT / "src/audio/soundBank.json"
    assets = json.loads(ap.read_text())
    bank = json.loads(bp.read_text())
    plans = {
        "chain-hit": [("large_iron_chain_drop_on_concrete.m4a", 5), ("large_iron_chain_rattle.m4a", 3)],
        "slack": [("large_iron_chain_pickup_7.m4a", 5), ("large_iron_chain_rattle.m4a", 3)],
    }
    recipe = []
    for family, sources in plans.items():
        keys = []
        for filename, count in sources:
            for cut, start in extract(filename, count):
                data = subprocess.check_output(["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
                    "-c:a", "libopus", "-b:a", "128k", "-f", "ogg", "-"], input=cut.tobytes())
                sha = hashlib.sha256(data).hexdigest()
                key = f"{family}-micro-v29-{len(keys) + 1}-{sha[:8]}"
                (ROOT / "public/sounds" / (key + ".ogg")).write_bytes(data)
                assets[key] = {"file": f"/sounds/{key}.ogg", "sha256": sha, "bytes": len(data), "seconds": len(cut) / SR,
                    "name": key.rsplit('-', 1)[0] + ".ogg", "source": f"User-provided download: {filename} ({start:.3f}–{start + len(cut)/SR:.3f}s; 400 Hz high-pass; onset/decay fades; native pitch; -18 dBFS peak)", "author": "", "license": ""}
                recipe.append({"key": key, "source": filename, "start": start, "end": start + len(cut) / SR})
                keys.append(key)
        bank["slots"][family] = {"sounds": keys, "volume": -5 if family == "chain-hit" else -10,
            "refSpeed": 2 if family == "chain-hit" else 1, "pitchJitter": 0.25, "pitchFollow": 0, "paceFollow": 0}
        print(f"{family}: {len(keys)} distinct 50 ms gestures")
    for slot in list(bank["slots"]):
        if slot == "chain-drop" or slot.startswith("chain-drop."):
            del bank["slots"][slot]
    assigned = {key for params in bank["slots"].values() for key in params.get("sounds", [])}
    assets = {key: value for key, value in assets.items() if key in assigned}
    bank["clips"] = {key: value for key, value in bank["clips"].items() if key in assigned}
    ap.write_text(json.dumps(assets, indent=2) + "\n")
    bp.write_text(json.dumps(bank, indent=2) + "\n")
    (HERE / "microfoley-cuts.json").write_text(json.dumps(recipe, indent=2) + "\n")


if __name__ == "__main__": main()
