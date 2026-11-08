"""Offline sound design: reproducible stems, REAPER projects, and measurements.

Run with tools/audio/.venv/bin/python tools/audio/audio.py --help from rope/.
No network calls. Rendered candidates are deliberately not assigned to the game.
"""
import argparse
import hashlib
import json
import os
from fractions import Fraction
from pathlib import Path
import subprocess
import urllib.request

import numpy as np
from scipy import signal
import soundfile as sf

HERE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_audio(path):
    try:
        samples, sr = sf.read(path, always_2d=True)
    except (sf.LibsndfileError, RuntimeError):
        raw = subprocess.run([
            "ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le",
            "-ar", "48000", "-ac", "1", "pipe:1",
        ], check=True, capture_output=True).stdout
        samples, sr = np.frombuffer(raw, dtype="<f4").reshape(-1, 1), 48000
    if not samples.size or not np.isfinite(samples).all():
        raise ValueError(f"{path}: empty or non-finite audio")
    return samples, sr


def db(value):
    return round(float(20 * np.log10(max(float(value), 1e-12))), 2)


def measure(path):
    x, sr = read_audio(path)
    peak = np.max(np.abs(x))
    envelope = np.max(np.abs(x), axis=1)
    # Relative -40 dB gate excludes silent padding; not perceptual loudness.
    active = envelope > max(peak * 0.01, 1e-7)
    indices = np.flatnonzero(active)
    rms = np.sqrt(np.mean(x * x))
    active_rms = np.sqrt(np.mean(x[active] ** 2)) if indices.size else 0
    f, power = signal.periodogram(x, sr, axis=0)
    power = power.sum(axis=1)
    centroid = float(np.sum(f * power) / max(np.sum(power), 1e-20))
    return {
        "file": str(path), "sha256": digest(path), "sampleRate": sr,
        "channels": x.shape[1], "seconds": round(len(x) / sr, 5),
        "peakDbfs": db(peak), "rmsDbfs": db(rms), "activeRmsDbfs": db(active_rms),
        "crestDb": round(db(peak) - db(rms), 2),
        "samplesAtFullScale": int(np.sum(np.abs(x) >= 1)),
        "dcOffset": float(np.mean(x)), "spectralCentroidHz": round(centroid, 1),
        "onsetSeconds": round(int(indices[0]) / sr, 5) if indices.size else None,
        "tailSeconds": round((len(x) - int(indices[-1]) - 1) / sr, 5) if indices.size else None,
        "loopBoundaryJump": float(np.max(np.abs(x[-1] - x[0]))),
        "note": "Sample peak and gated RMS, not true peak or perceptual quality. Boundary jump alone cannot certify a seamless loop.",
    }


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def write_project(path, tracks, sr):
    # All edits are baked into stem WAVs, so REAPER sums exactly the same mix.
    seconds = max(track[2] for track in tracks)
    lines = ["<REAPER_PROJECT 0.1 7 1", f"  SAMPLERATE {sr} 1 0",
             f"  RENDER_FILE {json.dumps(str(path.with_name(path.stem + '-reaper.wav').resolve()))}",
             f"  RENDER_FMT 0 1 {sr}", "  RENDER_STEMS 0", "  RENDER_DITHER 0",
             f"  RENDER_RANGE 0 0 {seconds} 0 0", "  RENDER_TAILFLAG 0",
             "  <RENDER_CFG", "    ZXZhdxgAAA==", "  >"]
    for name, file, seconds in tracks:
        # JSON string quoting is compatible with these generated RPP strings.
        lines += ["  <TRACK", f"    NAME {json.dumps(name)}", "    VOLPAN 1 0 1 -1",
                  "    <ITEM", "      POSITION 0", f"      LENGTH {seconds}",
                  "      VOLPAN 1 0 1 -1", "      FADEIN 1 0 0", "      FADEOUT 1 0 0",
                  "      <SOURCE WAVE", f"        FILE {json.dumps(file.name)}",
                  "      >", "    >", "  >"]
    lines += [">"]
    path.write_text("\n".join(lines) + "\n")


def render(recipe_path, out):
    recipe = json.loads(recipe_path.read_text())
    sr = int(recipe["sampleRate"])
    candidates = []
    for spec in recipe["candidates"]:
        name = spec["name"]
        if not name or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in name):
            raise ValueError("Candidate names must use lowercase letters, digits and hyphens")
        directory = out / name
        saved_spec = dict(spec)
        if spec.get("recording"):
            saved_spec["recording"] = os.path.relpath((recipe_path.parent / spec["recording"]).resolve(), directory.resolve())
        saved_recipe = {"sampleRate": sr, "seed": recipe["seed"], "candidates": [saved_spec]}
        saved_path = directory / "recipe.json"
        if saved_path.exists() and json.loads(saved_path.read_text()) != saved_recipe:
            raise ValueError(f"{name} already has a different recipe. Use a new versioned name or a different --out directory.")
        directory.mkdir(parents=True, exist_ok=True)
        n = int(sr * spec["seconds"])
        if not 0 < n <= sr * 30:
            raise ValueError("Candidate duration must be between 0 and 30 seconds")
        t = np.arange(n) / sr
        rng = np.random.default_rng(recipe["seed"])
        attack = 1 - np.exp(-t / 0.0008)
        body = np.sin(2 * np.pi * spec["bodyHz"] * (t + 0.012 * (1 - np.exp(-t / 0.012))))
        body *= attack * np.exp(-t / spec["bodyDecay"])
        metal = np.zeros(n)
        for ratio, gain in [(1, 1), (1.483, 0.55), (2.117, 0.3), (3.073, 0.16)]:
            metal += gain * np.sin(2 * np.pi * spec["metalHz"] * ratio * t) * np.exp(-t * ratio / spec["metalDecay"])
        metal *= attack
        sos = signal.butter(2, spec["detailHz"], "lowpass", fs=sr, output="sos")
        detail = signal.sosfilt(sos, rng.normal(0, 1, n)) * attack * np.exp(-t / 0.023)
        layers = [body, metal, detail]
        labels = ["body", "metal", "detail"]
        layers = [x * gain for x, gain in zip(layers, spec["gains"], strict=True)]
        if spec.get("recording"):
            file = recipe_path.parent / spec["recording"]
            if not file.exists():
                raise ValueError(f"Missing recording {file}; run bun run audio:sources first")
            recorded, source_sr = read_audio(file)
            recorded = recorded.mean(axis=1)
            ratio = Fraction(sr / source_sr / 2 ** (spec.get("recordingPitch", 0) / 12)).limit_denominator(1000)
            recorded = signal.resample_poly(recorded, ratio.numerator, ratio.denominator)
            sos = signal.butter(2, spec.get("recordingLowpass", 6500), "lowpass", fs=sr, output="sos")
            recorded = signal.sosfilt(sos, recorded)
            layer = np.zeros(n)
            length = min(n, len(recorded))
            layer[:length] = recorded[:length] * spec.get("recordingGain", 0.5)
            layers.append(layer)
            labels.append("chain-recording")
        # A shared gain preserves the layer balance in both WAV mix and RPP.
        scale = 10 ** (-3 / 20) / max(float(np.max(np.abs(sum(layers)))), 1e-12)
        fade = np.ones(n)
        tail = min(int(sr * 0.015), n)
        fade[-tail:] = np.linspace(1, 0, tail)
        layers = [x * scale * fade for x in layers]
        tracks = []
        for label, samples in zip(labels, layers, strict=True):
            path = directory / f"{label}.wav"
            sf.write(path, samples, sr, subtype="FLOAT")
            tracks.append((label, path, n / sr))
        mix = directory / f"{name}.wav"
        sf.write(mix, sum(layers), sr, subtype="PCM_24")
        write_project(directory / f"{name}.rpp", tracks, sr)
        save_json(directory / "recipe.json", saved_recipe)
        report = measure(mix)
        save_json(directory / "analysis.json", report)
        candidates.append({"name": name, "event": spec["event"],
                           "file": f"{name}/{mix.name}", "sha256": report["sha256"],
                           "source": spec.get("source", "tools/audio/audio.py + recipes.json"),
                           "author": spec.get("author", "Project procedural sound design"),
                           "license": spec.get("license", "Project LICENSE")})
    save_json(out / "manifest.json", {"candidates": candidates})
    print(f"Rendered {len(candidates)} candidates and their stems to {out}")


def import_source(args):
    """Keep originals and explicit provenance; never infer somebody's licence."""
    path = args.file.resolve()
    if not all(getattr(args, field).strip() for field in ["source", "author", "license"]):
        raise ValueError("Source, author, and licence must not be blank")
    x, sr = read_audio(path)
    key = f"{digest(path)[:12]}-{path.stem}"
    directory = HERE / "sources" / key
    directory.mkdir(parents=True, exist_ok=True)
    original = directory / path.name
    if original != path:
        original.write_bytes(path.read_bytes())
    sf.write(directory / "working.wav", x, sr, subtype="FLOAT")
    save_json(directory / "source.json", {"original": path.name, "sha256": digest(original),
              "source": args.source, "author": args.author, "license": args.license})
    print(directory)


def fetch_sources():
    """Fetch only the explicitly listed, hash-pinned source WAVs."""
    for entry in json.loads((HERE / "source-library.json").read_text()):
        path = HERE / "sources" / entry["file"]
        if not path.exists() or digest(path) != entry["sha256"]:
            with urllib.request.urlopen(entry["download"], timeout=20) as response:
                data = response.read(64 * 1024 * 1024 + 1)
            if len(data) > 64 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise ValueError(f"Source download failed integrity check: {entry['name']}")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        read_audio(path)
        save_json(path.with_suffix(".source.json"), entry)
        print(f"Ready: {entry['name']} ({entry['license']})")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("fetch-sources", help="Fetch hash-pinned CC0 source recordings")
    p = sub.add_parser("render", help="Render editable candidates and REAPER projects")
    p.add_argument("--recipe", type=Path, default=HERE / "recipes.json")
    p.add_argument("--out", type=Path, default=HERE / "out")
    p = sub.add_parser("analyze", help="Measure WAV/FLAC/OGG or any FFmpeg-readable file")
    p.add_argument("files", nargs="+", type=Path)
    p.add_argument("--out", type=Path)
    p = sub.add_parser("import", help="Import a licensed recording with provenance")
    p.add_argument("file", type=Path)
    for field in ["source", "author", "license"]:
        p.add_argument(f"--{field}", required=True)
    args = parser.parse_args()
    if args.command == "fetch-sources":
        fetch_sources()
    elif args.command == "render":
        render(args.recipe, args.out)
    elif args.command == "import":
        import_source(args)
    else:
        reports = [measure(path) for path in args.files]
        if args.out:
            save_json(args.out, reports)
        else:
            print(json.dumps(reports, indent=2))


if __name__ == "__main__":
    main()
