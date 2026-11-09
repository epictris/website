"""Import the six user-selected iron-chain recordings at native pitch.
Run from any directory; originals stay in sources/ with pinned hashes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RECORDINGS = {
    "deploy": "large_iron_chain_drop_1.m4a",
    "chain-drag": "large_iron_chain_drag_on_stone.m4a",
    "taut": "large_iron_chain_move_1.m4a",
    "slack": "large_iron_chain_pickup_7.m4a",
    "wrap": "large_iron_chain_rattle.m4a",
    "chain-drop": "large_iron_chain_drop_on_concrete.m4a",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=Path.home() / "Downloads")
    args = parser.parse_args()
    for name in RECORDINGS.values():
        if not (args.source_dir / name).is_file():
            raise FileNotFoundError(args.source_dir / name)
    bank_path = ROOT / "src/audio/soundBank.json"
    assets_path = ROOT / "src/audio/soundAssets.json"
    bank = json.loads(bank_path.read_text())
    assets = json.loads(assets_path.read_text())
    backup = HERE / "out" / ("before-iron-chain-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".json")
    backup.parent.mkdir(parents=True, exist_ok=True)
    backup.write_text(json.dumps({"bank": bank, "assets": assets}, indent=2) + "\n")
    sources_path = HERE / "local-sources.json"
    sources = json.loads(sources_path.read_text())
    (HERE / "sources").mkdir(exist_ok=True)
    public = ROOT / "public/sounds"
    public.mkdir(parents=True, exist_ok=True)
    for family, name in RECORDINGS.items():
        source = args.source_dir / name
        pinned = HERE / "sources" / name
        shutil.copyfile(source, pinned)
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        entry = {"name": name, "file": name, "originalName": name, "sha256": digest,
                 "source": "User-provided download: " + name, "author": "", "license": ""}
        sources = [s for s in sources if s["name"] != name] + [entry]
        # These originals now feed micro-foley cuts rather than a slack loop
        # or complete drop performance. The builder below assigns the cuts.
        if family in {"slack", "chain-drop"}:
            continue
        temp = HERE / "out" / (source.stem + ".ogg")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(pinned), "-af",
                        "silenceremove=start_periods=1:start_duration=0.002:start_threshold=-50dB,afade=t=in:d=0.002",
                        "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "96k", str(temp)], check=True)
        data = temp.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        key = source.stem.replace("_", "-") + "-" + sha[:8]
        shutil.copyfile(temp, public / (key + ".ogg"))
        seconds = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(temp)]))
        assets[key] = {"file": "/sounds/" + key + ".ogg", "sha256": sha, "bytes": len(data),
                       "seconds": seconds, "name": name, "source": entry["source"], "author": "", "license": ""}
        # Replace all old surface overrides so none mask the requested source.
        for slot in bank["slots"]:
            if slot.startswith(family + "."):
                bank["slots"][slot].pop("sounds", None)
        params = bank["slots"].setdefault(family, {})
        params.update(sounds=[key], pitchJitter=0)
        if family in {"deploy", "slack", "chain-drag"}:
            params.update(pitchFollow=0, paceFollow=0)
        if family == "chain-drag":
            params.update(volume=-8, refSpeed=1)
        if family == "chain-drop":
            params.update(volume=-6, refSpeed=2)
        # Per-link geometry collisions need a short transient, not a whole
        # one-second rattle at every link crossing. Keep the original intact.
        if family == "taut":
            bank.setdefault("clips", {})[key] = {"start": 0.099, "end": 0.235}
        if family == "wrap":
            bank.setdefault("clips", {})[key] = {"end": 0.1}
        print(f"{family}: {name} ({seconds:.3f}s; native pitch)")
    assigned = {k for slot in bank["slots"].values() for k in slot.get("sounds", [])}
    assets = {k: v for k, v in assets.items() if k in assigned}
    bank["clips"] = {k: v for k, v in bank.get("clips", {}).items() if k in assigned}
    sources_path.write_text(json.dumps(sources, indent=2) + "\n")
    bank_path.write_text(json.dumps(bank, indent=2) + "\n")
    assets_path.write_text(json.dumps(assets, indent=2) + "\n")
    subprocess.run([sys.executable, str(HERE / "refine-chain-wrap.py")], check=True)
    subprocess.run([str(HERE / ".venv/bin/python"), str(HERE / "build-chain-microfoley.py")], check=True)
    print("Backup:", backup)


if __name__ == "__main__":
    main()
