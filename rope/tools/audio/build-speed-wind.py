"""Build a native-pitch speed-wind bed from the user's wind_gust.m4a.
Run with tools/audio/.venv/bin/python; originals and provenance are retained.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import numpy as np
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SR = 48000

def main():
    original = Path.home() / "Downloads/wind_gust.m4a"
    source = HERE / "sources/wind_gust.m4a"
    if original.exists(): shutil.copyfile(original, source)
    assert source.exists(), "Provide wind_gust.m4a in Downloads or tools/audio/sources"
    # The original is 96 seconds, with a long fade-in/out and separate strong
    # gusts. Use a steady middle stretch so game motion supplies the swelling.
    start, end, fade = 24, 40, 0.2
    x = np.frombuffer(subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(source),
        "-af", f"atrim=start={start}:end={end},highpass=f=70", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],), dtype=np.float32).copy()
    n = round(fade * SR)
    u = np.linspace(0, 1, n, endpoint=False)
    x = np.concatenate((x[n:-n], x[-n:] * (1 - u) + x[:n] * u))
    # Reproducible RMS calibration; the game owns speed and acceleration gain.
    x *= 10 ** (-20 / 20) / np.sqrt(np.mean(x * x))
    x = x.astype(np.float32)
    data = subprocess.check_output(["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
        "-c:a", "libopus", "-b:a", "128k", "-f", "ogg", "-"], input=x.tobytes())
    sha = hashlib.sha256(data).hexdigest()
    key = "speed-wind-v30-" + sha[:8]
    (ROOT / "public/sounds" / (key + ".ogg")).write_bytes(data)
    ap = ROOT / "src/audio/soundAssets.json"
    bp = ROOT / "src/audio/soundBank.json"
    assets, bank = json.loads(ap.read_text()), json.loads(bp.read_text())
    assets[key] = {"file": f"/sounds/{key}.ogg", "sha256": sha, "bytes": len(data), "seconds": len(x)/SR,
        "name": "speed-wind-v30.ogg", "source": "User-provided download: wind_gust.m4a (24–40 s; mono; 70 Hz high-pass; 200 ms circular crossfade; native pitch; -20 dBFS RMS)", "author": "", "license": ""}
    bank["slots"]["whoosh"] = {"sounds": [key], "volume": -6, "refSpeed": 12, "pitchJitter": 0, "pitchFollow": 0, "paceFollow": 0}
    assigned = {k for p in bank["slots"].values() for k in p.get("sounds", [])}
    assets = {k: v for k, v in assets.items() if k in assigned}
    ap.write_text(json.dumps(assets, indent=2) + "\n")
    bp.write_text(json.dumps(bank, indent=2) + "\n")
    local = HERE / "local-sources.json"
    sources = [s for s in json.loads(local.read_text()) if s["name"] != source.name]
    sources.append({"name": source.name, "file": source.name, "originalName": original.name, "sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "source": "User-provided download: wind_gust.m4a", "author": "", "license": ""})
    local.write_text(json.dumps(sources, indent=2) + "\n")
    print(f"Assigned {len(x)/SR:.1f}s circular wind bed to Whoosh at native pitch; RMS -20 dBFS, peak {20*np.log10(max(abs(x))):.1f} dBFS")

if __name__ == "__main__": main()
