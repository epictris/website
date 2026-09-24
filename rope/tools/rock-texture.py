"""Prepare a downloaded texture set for the rock props.

    python3 tools/rock-texture.py <set.zip | set dir> <out dir> [--plain] [--mean 150] [--keep 0.15]

Reads the base colour, GL normal and roughness maps out of a freestylized-style
set (a zip as downloaded, or its unpacked directory) and writes
`basecolor.png`, `normal.png` and `roughness.png` into the out directory,
which is what a rock job's `textures` set name resolves to
(`assets-src/rock-textures/<name>/`, see docs/rock-assets.md).

By default the base colour is TREATED for the pale stylised rock look:

- desaturated to `--keep` of its saturation and remapped so the mean lands at
  `--mean` on 255, with a faint cool cast. freestylized's "cliff rocks 07" as
  shipped is a dark grey (mean 100) with ochre strata;
- its crumbly pale patches flattened: blobs that are the ochre crumbles in the
  source (found by chroma, opened so the thin strata veins drop out) are
  filled from their surroundings and the normal map flattened under them.
  Left in, each one is a recognisable stamp on a rock about one tile across.

`--plain` copies the three maps untouched (the moss sets are used as they are).
"""

import argparse
import glob
import os
import shutil
import tempfile
import zipfile

import numpy as np
from PIL import Image, ImageFilter


CHROMA = 0.05  # max - min of the source RGB above which a texel is an ochre crumble


def find(dirname, patterns):
    """The first map whose name contains one of `patterns`, anywhere under
    the directory (a zip unpacks into a folder of its own)."""
    for pattern in patterns:
        hits = sorted(glob.glob(os.path.join(dirname, "**", f"*{pattern}*.png"), recursive=True))
        if hits:
            return hits[0]
    raise SystemExit(f"no *{patterns}*.png under {dirname}")


def luminance(rgb):
    return rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def box1d(arr, r, axis):
    """Box filter of half-width r along one axis, edges reflected."""
    n = arr.shape[axis]
    pad = [(0, 0)] * arr.ndim
    pad[axis] = (r, r)
    a = np.pad(arr, pad, mode="reflect")
    c = np.cumsum(a, axis=axis, dtype=np.float64)
    c = np.concatenate([np.zeros_like(np.take(c, [0], axis=axis)), c], axis=axis)
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(c, np.arange(0, n), axis=axis)
    return ((hi - lo) / (2 * r + 1)).astype(np.float32)


def blur(arr, radius):
    """Gaussian-like blur at full float precision: three separable box
    passes (PIL's blur is 8-bit, which contoured the luminance maps)."""
    r = max(1, int(radius))
    out = arr
    for _ in range(3):
        out = box1d(box1d(out, r, 0), r, 1)
    return out


def patch_mask(source, size):
    """Where the crumbly patches are. In the set as shipped they are the ochre
    crumbles, so chroma in the SOURCE finds them cleanly; the mask is opened so
    the thin ochre strata veins drop out and only blobs wider than a vein stay,
    then feathered."""
    chroma = source.max(axis=2) - source.min(axis=2)
    warm = chroma > CHROMA
    m = Image.fromarray((warm * 255).astype(np.uint8))
    k = max(3, (size // 300) | 1)
    opened = m.filter(ImageFilter.MinFilter(k)).filter(ImageFilter.MaxFilter(k * 3))
    mask = np.asarray(opened).astype(np.float32) / 255
    return np.clip(blur(mask, size // 200), 0, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("set_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--mean", type=float, default=150.0)
    ap.add_argument("--keep", type=float, default=0.15)
    ap.add_argument("--no-flatten", action="store_true")
    ap.add_argument("--plain", action="store_true", help="copy the maps untouched")
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    set_dir = args.set_dir
    if set_dir.endswith(".zip"):
        set_dir = tempfile.mkdtemp(prefix="rock-texture-")
        with zipfile.ZipFile(args.set_dir) as z:
            z.extractall(set_dir)
    base_path = find(set_dir, ("basecolor", "Base_Color", "BaseColor"))
    normal_path = find(set_dir, ("normal_gl", "Normal_gl", "NormalGL"))
    rough_path = find(set_dir, ("roughness", "Roughness"))
    if args.plain:
        for src, dst in ((base_path, "basecolor.png"), (normal_path, "normal.png"), (rough_path, "roughness.png")):
            shutil.copy(src, os.path.join(args.out_dir, dst))
        print(f"wrote {args.out_dir}: maps copied untouched")
        return

    base = np.asarray(Image.open(base_path).convert("RGB")).astype(np.float32) / 255
    size = base.shape[0]
    lum = luminance(base)
    grey = np.repeat(lum[..., None], 3, axis=2)
    mixed = grey * (1 - args.keep) + base * args.keep
    g = np.log(args.mean / 255) / np.log(mixed.mean())
    out = np.clip(mixed ** g, 0, 1) * np.array([0.985, 1.0, 1.02], dtype=np.float32)

    normal = np.asarray(Image.open(normal_path).convert("RGB")).astype(np.float32) / 255
    if not args.no_flatten:
        mask = patch_mask(base, size)[..., None]
        # The fill is the surroundings only: a blur normalised by the blurred
        # coverage, so a patch's own brightness never leaks into it.
        keep = 1 - mask
        fill = blur(out * keep, size // 30) / np.maximum(blur(keep, size // 30), 1e-3)
        out = out * keep + fill * mask
        flat = np.array([0.5, 0.5, 1.0], dtype=np.float32)
        normal = normal * (1 - mask) + flat * mask
        print(f"flattened {mask.mean() * 100:.1f}% of the tile")

    Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)).save(os.path.join(args.out_dir, "basecolor.png"))
    Image.fromarray((np.clip(normal, 0, 1) * 255 + 0.5).astype(np.uint8)).save(os.path.join(args.out_dir, "normal.png"))
    shutil.copy(rough_path, os.path.join(args.out_dir, "roughness.png"))
    print(f"wrote {args.out_dir}: base mean {out.mean() * 255:.0f}/255")


if __name__ == "__main__":
    main()
