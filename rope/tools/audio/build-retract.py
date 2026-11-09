"""Cut the chain retract's zip from the deploy's own recording and assign it.
Run with tools/audio/.venv/bin/python. The original source file is untouched.

The retract follows every deploy, so it is built to pair with it and not to
wear: one short zip of links. Three ~110 ms windows of the rattle in
`large_iron_chain_drop_1.m4a`, the recording the deploy loop is cut from
(0.0-0.345 s): the same chain going the other way. Unfiltered, as the deploy is, with a short raised-cosine fade in
(so it does not start on a cut) and out. It sits under the deploy by level
alone (`UNDER_DEPLOY`).

v31 low-passed the zips at 3 kHz to sit darker under the deploy, and they
sounded "weirdly wet" (Tris, 2026-11-09): this recording's character is
nearly all above 3 kHz (74% of the deploy file's energy, 84% of the source's
rattle), and the low-pass left the zips 4-26% - the dull body of each link
strike without its metal edge - with a 40 ms fade in softening every attack
besides. The first seat cut, low-passed the same, was "wet" too.

No seat - a sound as the chain's end reaches the loop. Three were tried and
rejected by ear on 2026-11-09, and Tris had it removed: a cut of this
recording's last settling link at 0.40 s ("like a wet sort of clicking"),
the Chain link impact clinks, and one Wind link.

Native gain, as the deploy file is (both peak near -1.6 dBFS). The slot volume
is set from measurement: the cuts' mean RMS against the deploy file's, plus
the deploy slot's own volume, less `UNDER_DEPLOY`. Rebuilding replaces the
previous retract cuts and their assignment.
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SR = 48000
SOURCE = "large_iron_chain_drop_1.m4a"
# Inside the full rattle, 0.08-0.31 s: each window 72-86% of its energy above
# 3 kHz, as the deploy file is (74%). Not the lead-in before 0.08 s, which is
# quiet and dull (a window starting at 0.04 s was 18%).
ZIP_STARTS = [0.08, 0.14, 0.20]
ZIP_LENGTH = 0.11
ZIP_FADE_IN = 0.01
ZIP_FADE_OUT = 0.03
# How far under the deploy the zip plays, dB of RMS.
UNDER_DEPLOY = 7
VERSION = "v32"


def decode(path):
    return np.frombuffer(subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path),
        "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]), dtype=np.float32).copy()


def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)))


def raised(n):
    return np.sin(np.linspace(0, np.pi / 2, n)) ** 2


def zips(x):
    for start in ZIP_STARTS:
        a = int(start * SR)
        cut = x[a:a + int(ZIP_LENGTH * SR)].copy()
        fi, fo = int(ZIP_FADE_IN * SR), int(ZIP_FADE_OUT * SR)
        cut[:fi] *= raised(fi)
        cut[-fo:] *= raised(fo)[::-1]
        yield cut, start


def encode(cut):
    return subprocess.check_output(["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
        "-c:a", "libopus", "-b:a", "128k", "-f", "ogg", "-"], input=cut.astype(np.float32).tobytes())


def main():
    ap = ROOT / "src/audio/soundAssets.json"
    bp = ROOT / "src/audio/soundBank.json"
    assets = json.loads(ap.read_text())
    bank = json.loads(bp.read_text())
    backup = HERE / "out" / ("before-retract-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".json")
    backup.parent.mkdir(parents=True, exist_ok=True)
    backup.write_text(json.dumps({"bank": bank, "assets": assets}, indent=2) + "\n")
    # Replace any previous build's cuts.
    for key in [k for k in assets if k.startswith("retract-")]:
        (ROOT / "public/sounds" / (key + ".ogg")).unlink(missing_ok=True)
        del assets[key]
    x = decode(HERE / "sources" / SOURCE)
    recipe = []

    def add(name, cut, start, note):
        data = encode(cut)
        sha = hashlib.sha256(data).hexdigest()
        key = f"{name}-{sha[:8]}"
        (ROOT / "public/sounds" / (key + ".ogg")).write_bytes(data)
        window = f"{start:.3f}-{start + len(cut) / SR:.3f}s"
        assets[key] = {"file": f"/sounds/{key}.ogg", "sha256": sha, "bytes": len(data), "seconds": len(cut) / SR,
            "name": name + ".ogg",
            "source": f"User-provided download: {SOURCE} ({window}; unfiltered; {note}; native pitch and gain)",
            "author": "", "license": ""}
        recipe.append({"key": key, "source": SOURCE, "window": window, "note": note})
        return key

    cuts = list(zips(x))
    zip_keys = [add(f"retract-zip-{VERSION}-{i + 1}", cut, start, "raised-cosine fade in and out")
                for i, (cut, start) in enumerate(cuts)]
    # The level: `UNDER_DEPLOY` under the deploy as it plays (its file's RMS
    # at its slot's volume), measured rather than typed.
    deploy = bank["slots"]["deploy"]
    deploy_db = rms_db(decode(ROOT / "public/sounds" / (deploy["sounds"][0] + ".ogg"))) + deploy.get("volume", 0)
    zip_db = float(np.mean([rms_db(cut) for cut, _ in cuts]))
    volume = round(2 * (deploy_db - UNDER_DEPLOY - zip_db)) / 2
    print(f"deploy plays at {deploy_db:.1f} dB RMS, zips are {zip_db:.1f}: volume {volume:+.1f} dB")
    bank["slots"]["retract"] = {"sounds": zip_keys, "volume": volume, "refSpeed": 12, "pitchJitter": 0.25}
    # The seat slot is gone (see the header); so is any assignment to it.
    bank["slots"].pop("retract-seat", None)
    ap.write_text(json.dumps(assets, indent=2) + "\n")
    bp.write_text(json.dumps(bank, indent=2) + "\n")
    (HERE / "retract-cuts.json").write_text(json.dumps(recipe, indent=2) + "\n")
    for r in recipe:
        print(r["key"], r["window"])


if __name__ == "__main__":
    main()
