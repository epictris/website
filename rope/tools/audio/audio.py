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


def recorded_layers(spec, recipe_path, sr, n):
    """Edit real transients without adding oscillators, modal rings, or reverb."""
    layers, labels = [], []
    for edit in spec["recordedLayers"]:
        path = recipe_path.parent / edit["file"]
        x, source_sr = read_audio(path)
        x = x.mean(axis=1)
        start = round(edit.get("start", 0) * source_sr)
        end = round(edit.get("end", len(x) / source_sr) * source_sr)
        x = x[start:end]
        if not len(x):
            raise ValueError(f"Empty recording window: {path}")
        ratio = Fraction(sr / source_sr / 2 ** (edit.get("pitch", 0) / 12)).limit_denominator(1000)
        x = signal.resample_poly(x, ratio.numerator, ratio.denominator)
        for kind, key in [("highpass", "highpass"), ("lowpass", "lowpass")]:
            if edit.get(key):
                x = signal.sosfilt(signal.butter(2, edit[key], kind, fs=sr, output="sos"), x)
        length = min(n, len(x), round(edit.get("duration", n / sr) * sr))
        x = x[:length].copy()
        if edit.get("decay"):
            x *= np.exp(-np.arange(length) / sr / edit["decay"])
        fade_in = min(length, round(edit.get("fadeIn", 0) * sr))
        fade_out = min(length, round(edit.get("fadeOut", 0.005) * sr))
        if fade_in:
            x[:fade_in] *= np.linspace(0, 1, fade_in)
        if fade_out:
            x[-fade_out:] *= np.linspace(1, 0, fade_out)
        if edit.get("normalize", False):
            x /= max(float(np.max(np.abs(x))), 1e-12)
        layer = np.zeros(n)
        if "pulses" in edit:
            for pulse in edit["pulses"]:
                ratio = Fraction(2 ** (-pulse.get("pitch", 0) / 12)).limit_denominator(1000)
                grain = signal.resample_poly(x, ratio.numerator, ratio.denominator)
                at = round(pulse["at"] * sr)
                indices = (at + np.arange(len(grain))) % n
                np.add.at(layer, indices, grain * pulse.get("gain", 1) * edit.get("gain", 1))
        else:
            layer[:length] = x * edit.get("gain", 1)
        layers.append(layer)
        labels.append(edit["name"])
    if not layers:
        raise ValueError("A recording-led sound needs at least one layer")
    return layers, labels


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
        if "recordedLayers" in spec:
            saved_spec["recordedLayers"] = [
                {**edit, "file": os.path.relpath((recipe_path.parent / edit["file"]).resolve(), directory.resolve())}
                for edit in spec["recordedLayers"]
            ]
        saved_recipe = {"sampleRate": sr, "seed": recipe["seed"], "candidates": [saved_spec]}
        saved_path = directory / "recipe.json"
        if saved_path.exists() and json.loads(saved_path.read_text()) != saved_recipe:
            raise ValueError(f"{name} already has a different recipe. Use a new versioned name or a different --out directory.")
        directory.mkdir(parents=True, exist_ok=True)
        n = int(sr * spec["seconds"])
        if not 0 < n <= sr * 30:
            raise ValueError("Candidate duration must be between 0 and 30 seconds")
        if "recordedLayers" in spec:
            layers, labels = recorded_layers(spec, recipe_path, sr, n)
        else:
            t = np.arange(n) / sr
            rng = np.random.default_rng(recipe["seed"])
            attack = 1 - np.exp(-t / 0.0008)
            body = np.sin(2 * np.pi * spec["bodyHz"] * (t + spec.get("bodySweep", 0.012) * (1 - np.exp(-t / 0.012))))
            body *= attack * np.exp(-t / spec["bodyDecay"])
            metal = np.zeros(n)
            for ratio, gain in [(1, 1), (1.483, 0.55), (2.117, 0.3), (3.073, 0.16)]:
                metal += gain * np.sin(2 * np.pi * spec["metalHz"] * ratio * t) * np.exp(-t * ratio / spec["metalDecay"])
            metal *= attack
            sos = signal.butter(2, spec["detailHz"], "lowpass", fs=sr, output="sos")
            detail = signal.sosfilt(sos, rng.normal(0, 1, n)) * attack * np.exp(-t / 0.023)
            # A short broadband contact body replaces the isolated bass oscillator
            # when a revision calls for a dense impact rather than a hollow tone.
            if "bodyNoise" in spec:
                sos = signal.butter(2, [45, spec.get("bodyNoiseHz", 700)], "bandpass", fs=sr, output="sos")
                contact = signal.sosfilt(sos, rng.normal(0, 1, n))
                contact /= max(float(np.sqrt(np.mean(contact ** 2))), 1e-12)
                contact *= attack * np.exp(-t / spec["bodyDecay"])
                amount = spec["bodyNoise"]
                body = body * (1 - amount) + contact * amount
            if spec.get("metalAttack"):
                metal *= (1 - np.exp(-t / spec["metalAttack"]))
            layers = [body, metal, detail]
            labels = ["body", "metal", "detail"]
            layers = [x * gain for x, gain in zip(layers, spec["gains"], strict=True)]
            def damp(samples, seconds):
                end = min(n, max(1, round(seconds * sr)))
                fade = min(end, round(0.005 * sr))
                samples[end - fade:end] *= np.linspace(1, 0, fade)
                samples[end:] = 0
                return samples
            if "metalDuration" in spec:
                layers[1] = damp(layers[1], spec["metalDuration"])
            if spec.get("bassGain"):
                # Keep weight separate from the broadband contact, so adding bass
                # does not replace the dense impact with an isolated hollow tone.
                bass = np.zeros(n)
                for ratio, gain in [(1, 1), (1.73, 0.3), (2.47, 0.14)]:
                    bass += gain * np.sin(2 * np.pi * spec["bassHz"] * ratio * t) * np.exp(-t * ratio / spec["bassDecay"])
                bass *= (1 - np.exp(-t / 0.0015)) * spec["bassGain"]
                layers.append(damp(bass, spec.get("bassDuration", spec["seconds"])))
                labels.append("bass")
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
                if "recordingDuration" in spec:
                    layer = damp(layer, spec["recordingDuration"])
                layers.append(layer)
                labels.append("chain-recording")
        # A shared gain preserves the layer balance in both WAV mix and RPP.
        scale = 10 ** (-3 / 20) / max(float(np.max(np.abs(sum(layers)))), 1e-12)
        scale *= 10 ** (spec.get("outputGainDb", 0) / 20)
        fade = np.ones(n)
        tail = min(int(sr * 0.015), n)
        if not spec.get("loop", False):
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
        candidates.append({"name": name, "event": spec["event"], "slot": spec.get("slot", spec["event"]),
                           "slots": spec.get("slots", [spec.get("slot", spec["event"])]),
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
