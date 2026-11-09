"""Cut native-speed rolling candidates, preserving stereo and relative levels."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

import numpy as np
import soundfile as sf
import audio

HERE = Path(__file__).resolve().parent
original = Path.home() / "Downloads/fast_to_slow_roll.m4a"
source = HERE / "sources" / original.name
source.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile(original, source)
rate = 44100
raw = subprocess.run([
    "ffmpeg", "-v", "error", "-i", str(source), "-f", "f32le",
    "-ar", str(rate), "-ac", "2", "pipe:1",
], check=True, capture_output=True).stdout
samples = np.frombuffer(raw, dtype="<f4").reshape(-1, 2)
windows = {"fast": (0.3, 2.8), "medium": (3.2, 5.7), "slow": (6.0, 8.0)}
credit = "User-provided download: fast_to_slow_roll.m4a"
metadata = {
    "name": source.name, "file": source.name, "originalName": source.name,
    "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "source": credit, "author": "", "license": "",
}
library_path = HERE / "local-sources.json"
library = json.loads(library_path.read_text())
library = [s for s in library if s["file"] != source.name] + [metadata]
audio.save_json(library_path, library)
manifest_path = HERE / "out/manifest.json"
manifest = json.loads(manifest_path.read_text())
for speed, (start, end) in windows.items():
    name = f"roll-{speed}-natural-v21"
    directory = HERE / "out" / name
    directory.mkdir(parents=True, exist_ok=True)
    clip = samples[round(start * rate):round(end * rate)].copy()
    fade = round(0.035 * rate)
    clip[:fade] *= np.linspace(0, 1, fade)[:, None]
    clip[-fade:] *= np.linspace(1, 0, fade)[:, None]
    file = directory / f"{name}.wav"
    sf.write(file, clip, rate, subtype="PCM_24")
    audio.save_json(directory / "analysis.json", audio.measure(file))
    audio.save_json(directory / "source-edit.json", {
        "source": "../../sources/" + source.name, "sourceSha256": metadata["sha256"],
        "start": start, "end": end, "fadeIn": .035, "fadeOut": .035,
        "gain": 1, "pitch": 0, "pace": 1, "channels": 2,
        "note": "Chronological speed bands from first rundown; listening approval pending. Fades do not certify a seamless loop.",
    })
    audio.write_project(directory / f"{name}.rpp", [(speed, file, end - start)], rate)
    candidate = {
        "name": name, "event": "roll", "slot": "roll", "slots": ["roll"],
        "file": f"{name}/{file.name}", "sha256": audio.digest(file),
        "source": credit + f" ({start}–{end} s)", "author": "", "license": "",
    }
    manifest["candidates"] = [c for c in manifest["candidates"] if c["name"] != name] + [candidate]
    print(f"{speed}: {start}–{end} s -> {file}")
audio.save_json(manifest_path, manifest)
