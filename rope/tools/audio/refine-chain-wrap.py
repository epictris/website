"""Build short native-pitch geometry clinks from the selected iron-chain rattle.
Run with python3 after import-chain-recordings.py; no synthesized layers.
"""
from array import array
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
# Bright individual attacks, rather than the quiet opening of the recording.
WINDOWS = [(0.254, 0.294), (0.350, 0.390), (0.397, 0.437)]


def main():
    source = HERE / "sources/large_iron_chain_rattle.m4a"
    assets_path = ROOT / "src/audio/soundAssets.json"
    bank_path = ROOT / "src/audio/soundBank.json"
    assets = json.loads(assets_path.read_text())
    bank = json.loads(bank_path.read_text())
    keys = []
    for i, (start, end) in enumerate(WINDOWS, 1):
        # Remove low handling rumble, keep the source's metallic pitch, and
        # fade both boundaries so rapid contacts cannot repeat cut clicks.
        data = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(source),
            "-af", f"atrim=start={start}:end={end},asetpts=PTS-STARTPTS,highpass=f=500,afade=t=in:d=0.001,afade=t=out:st=0.012:d=0.028",
            "-ac", "1", "-ar", "48000", "-f", "f32le", "-"])
        samples = array("f", data)
        peak = max(map(abs, samples))
        gain = 10 ** (-18 / 20) / max(peak, 1e-9)
        samples = array("f", (s * gain for s in samples))
        encoded = subprocess.check_output(["ffmpeg", "-v", "error", "-f", "f32le", "-ar", "48000", "-ac", "1", "-i", "-",
            "-c:a", "libopus", "-b:a", "128k", "-f", "ogg", "-"], input=samples.tobytes())
        sha = hashlib.sha256(encoded).hexdigest()
        key = f"chain-wrap-clink-v27-{i}-{sha[:8]}"
        (ROOT / "public/sounds" / (key + ".ogg")).write_bytes(encoded)
        assets[key] = {"file": f"/sounds/{key}.ogg", "sha256": sha, "bytes": len(encoded),
            "seconds": 0.04, "name": f"chain-wrap-clink-v27-{i}.ogg",
            "source": f"User-provided download: large_iron_chain_rattle.m4a ({start:.3f}–{end:.3f} s; native pitch; 500 Hz high-pass; onset/tail fades; -18 dBFS sample peak)",
            "author": "", "license": ""}
        keys.append(key)
    for slot, params in bank["slots"].items():
        if slot == "wrap" or slot.startswith("wrap."):
            params.pop("sounds", None)
    bank["slots"]["wrap"].update(sounds=keys, volume=-4, pitchJitter=0.25)
    assigned = {key for params in bank["slots"].values() for key in params.get("sounds", [])}
    assets = {key: asset for key, asset in assets.items() if key in assigned}
    bank["clips"] = {key: clip for key, clip in bank.get("clips", {}).items() if key in assigned}
    assets_path.write_text(json.dumps(assets, indent=2) + "\n")
    bank_path.write_text(json.dumps(bank, indent=2) + "\n")
    print("Assigned three 40 ms native-pitch clinks to Wrap; all surface overrides use this default.")


if __name__ == "__main__":
    main()
