"""Rebalance assigned effects using source measurements and explicit event levels.

Run with the audio venv. Default prints a proposal; --apply saves it and a
timestamped backup. Clip trims/pitch and unassigned events are preserved.
"""
import argparse
from datetime import datetime, timezone
import json
import urllib.request
from pathlib import Path
import numpy as np
import audio

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
LEVELS = {
    "land-light": (-2, 1), "land-medium": (0, 3.5), "land-heavy": (2, 8),
    "loop-hit": (-5, 1.5), "ball-settle": (-5, .8), "attach": (-2, 12),
    "taut": (-3, 3), "wind": (0, 3), "wrap": (-4, 1.5),
    "deploy": (-1, 12), "slack": (-3, 1), "roll": (3, 3),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--server", default="http://127.0.0.1:3100")
    args = parser.parse_args()
    path = ROOT / "src/audio/soundBank.json"
    original = path.read_text()
    bank = json.loads(original)
    assets = json.loads((ROOT / "src/audio/soundAssets.json").read_text())
    clips = bank.setdefault("clips", {})
    roles = {}
    for slot, params in bank["slots"].items():
        family = slot.split(".")[0]
        if not params.get("sounds") or family not in LEVELS:
            continue
        params["volume"], params["refSpeed"] = LEVELS[family]
        for key in params["sounds"]:
            roles.setdefault(key, set()).add(family)
    report = []
    for key, families in roles.items():
        edit = dict(clips.get(key, {}))
        x, sr = audio.read_audio(ROOT / "public" / assets[key]["file"].lstrip("/"))
        start = round(edit.get("start", 0) * sr)
        end = round(edit.get("end", len(x) / sr) * sr)
        x = x[start:end]
        if not len(x):
            raise ValueError(f"Empty clip: {key}")
        power = np.mean(x * x, axis=1)
        width = min(len(x), round(.05 * sr))
        sums = np.concatenate(([0.], np.cumsum(power)))
        burst = audio.db(np.sqrt(np.max((sums[width:] - sums[:-width]) / width)))
        # The source's loudest 50 ms is a repeatable transient baseline, not
        # perceptual loudness. Rolling is measured separately after its grain
        # normalization and recording-specific filters in the real browser.
        gain = 0 if families == {"roll"} else round(max(-24, min(24, -20 - burst)), 2)
        if gain:
            edit["volume"] = gain
        else:
            edit.pop("volume", None)
        if edit:
            clips[key] = edit
        else:
            clips.pop(key, None)
        report.append(dict(key=key, families=sorted(families), sourcePeakDb=audio.db(np.max(np.abs(x))), sourceBurstDb=burst, clipGainDb=gain))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output = HERE / "out"
    output.mkdir(exist_ok=True)
    audio.save_json(output / "mix-balance-proposal.json", bank)
    audio.save_json(output / "mix-balance-measurements.json", report)
    if args.apply:
        (output / f"bank-before-balance-{stamp}.json").write_text(original)
        request = urllib.request.Request(args.server.rstrip('/') + '/api/sounds/bank', data=json.dumps(bank).encode(), headers={'Content-Type': 'application/json'}, method='PUT')
        with urllib.request.urlopen(request, timeout=20) as response:
            json.load(response)
    print(json.dumps(dict(applied=args.apply, eventLevels=LEVELS, recordings=report), indent=2))


if __name__ == "__main__":
    main()
