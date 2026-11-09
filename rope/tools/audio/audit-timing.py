"""Audit every assigned playback window; --apply fixes clear timing defects.
Run with tools/audio/.venv/bin/python (NumPy and FFmpeg required).
Reports measurements, not a claim of perceptual listening assessment.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SR = 48000
LOOPS = {"roll", "deploy", "chain-drag", "hook-drag", "whoosh", "wade"}
# Existing encoded originals remain on disk; edits preserve their timbre/pitch.
LOOP_EDITS = {
    "deploy": ("large-iron-chain-drop-1-a8f83119", 0.0, 0.345, 0.012),
    "chain-drag": ("large-iron-chain-drag-on-stone-72d71ab1", 0.08, 1.4, 0.02),
}


def decode(path):
    return np.frombuffer(subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path),
        "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]), dtype=np.float32).copy()


def measure(x):
    width = 96  # 2 ms blocks retain fast attacks
    rms = np.array([np.sqrt(np.mean(x[i:i + width] ** 2)) for i in range(0, len(x), width)])
    active = np.flatnonzero(rms > max(1e-7, rms.max() * 10 ** (-45 / 20)))
    start = int(active[0] * width) if len(active) else 0
    end = min(len(x), int((active[-1] + 1) * width)) if len(active) else len(x)
    db = lambda v: round(float(20 * np.log10(abs(v) + 1e-12)), 2)
    return {"seconds": round(len(x) / SR, 6), "onsetSeconds": start / SR,
        "trailingQuietSeconds": (len(x) - end) / SR,
        "startSampleDbFS": db(x[0]), "endSampleDbFS": db(x[-1]),
        "loopSeamJumpDbFS": db(x[0] - x[-1]), "peakDbFS": db(np.max(abs(x)))}, start, end


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    ap = ROOT / "src/audio/soundAssets.json"
    bp = ROOT / "src/audio/soundBank.json"
    assets = json.loads(ap.read_text())
    bank = json.loads(bp.read_text())
    if args.apply:
        # Save the original, pre-audit windows for subsequent inspection.
        backup = HERE / "out/timing-audit-before.json"
        if not backup.exists():
            backup.write_text(json.dumps({"bank": bank, "assets": assets}, indent=2) + "\n")
        for family, (original, start, end, fade) in LOOP_EDITS.items():
            current = bank["slots"][family]["sounds"][0]
            if current.startswith(f"{family}-timed-v28-"):
                continue
            x = decode(ROOT / "public/sounds" / (original + ".ogg"))[round(start * SR):round(end * SR)]
            n = round(fade * SR)
            # Tail blends into the head, then the remaining head begins the
            # cycle. No artificial fade-to-silence at the loop seam.
            u = np.linspace(0, 1, n, endpoint=False)
            blend = x[-n:] * (1 - u) + x[:n] * u
            x = np.concatenate((x[n:-n], blend)).astype(np.float32)
            data = subprocess.check_output(["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
                "-c:a", "libopus", "-b:a", "128k", "-f", "ogg", "-"], input=x.tobytes())
            sha = hashlib.sha256(data).hexdigest()
            key = f"{family}-timed-v28-{sha[:8]}"
            (ROOT / "public/sounds" / (key + ".ogg")).write_bytes(data)
            old = assets[current]
            assets[key] = {**old, "file": f"/sounds/{key}.ogg", "sha256": sha, "bytes": len(data),
                "seconds": len(x) / SR, "name": family + "-timed-v28.ogg",
                "source": old["source"] + f"; encoded source window {start}–{end}s; {fade * 1000:g}ms circular crossfade; native pitch"}
            bank["slots"][family]["sounds"] = [key]
        taut = bank["slots"]["taut"]["sounds"][0]
        # First firm movement gesture, excluding the quiet preparatory motion
        # and the later unrelated movement in the complete recording.
        bank.setdefault("clips", {}).setdefault(taut, {}).update(start=0.099, end=0.235)
    roles = {}
    for slot, params in bank["slots"].items():
        for key in params.get("sounds", []):
            roles.setdefault(key, []).append(slot)
    report = []
    for key, slots in roles.items():
        asset = assets[key]
        raw = decode(ROOT / "public" / asset["file"].lstrip("/"))
        if args.apply:
            asset["seconds"] = round(len(raw) / SR, 6)
        edit = bank.setdefault("clips", {}).get(key, {})
        start = min(len(raw) - 1, round(edit.get("start", 0) * SR))
        end = min(len(raw), round(edit.get("end", len(raw) / SR) * SR))
        original_start = start
        before, active_start, active_end = measure(raw[start:end])
        loop = any(slot.split(".")[0] in LOOPS for slot in slots)
        if args.apply and not loop:
            # Preserve 2 ms before an attack and 20 ms after the last audible
            # block. Only remove quiet padding exceeding 20/40 ms.
            if active_start / SR > 0.02:
                start += max(0, active_start - 96)
            if (end - (original_start + active_end)) / SR > 0.04:
                # active_end is relative to the original playback start.
                end = min(end, original_start + active_end + 960)
            updated = dict(edit)
            if start > 0: updated["start"] = round(start / SR, 6)
            if end < len(raw): updated["end"] = round(end / SR, 6)
            bank["clips"][key] = updated
        after, _, _ = measure(raw[start:end])
        report.append({"key": key, "slots": slots, "mode": "loop" if loop else "one-shot",
            "startSeconds": start / SR, "endSeconds": end / SR, "before": before, "after": after,
            "boundaryTreatment": "circular source crossfade" if "timed-v28" in key else
                "random overlapping rolling grains" if "roll" in slots else
                "0.5ms runtime attack and 4ms runtime release" if not loop else "existing loop renderer"})
        print(','.join(slots), f"{start/SR:.3f}–{end/SR:.3f}s", f"lead {after['onsetSeconds']*1000:.0f}ms", f"quiet tail {after['trailingQuietSeconds']*1000:.0f}ms")
    if args.apply:
        assigned = set(roles)
        assets = {key: value for key, value in assets.items() if key in assigned}
        bank["clips"] = {key: value for key, value in bank["clips"].items() if key in assigned and value}
        ap.write_text(json.dumps(assets, indent=2) + "\n")
        bp.write_text(json.dumps(bank, indent=2) + "\n")
    (HERE / "timing-audit.json").write_text(json.dumps({"threshold": "2ms RMS blocks, -45dB relative to peak block RMS; measured decoded audio", "applied": args.apply, "samples": report}, indent=2) + "\n")


if __name__ == "__main__":
    main()
