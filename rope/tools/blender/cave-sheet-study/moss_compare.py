"""moss_compare.py [surfaces...]: the moss study's review sheet and its numbers.

out/moss/cmp_moss.png: the two references (mid-ledge top, rock-a 3/4) on the first
row, then one row per surface: 3/4, top, close. Prints the moss colour by brightness
band (shade / mid / lit) for each render beside the reference's, sampled the way the
rock study did (docs/cave-look.md): the moss pixels by hue, then the 0-20, 40-60 and
85-100 percentile bands of value.
"""
import os
import sys

import numpy as np
try:
    from PIL import Image, ImageDraw
except ImportError:   # inside Blender, which only needs bands_of
    Image = ImageDraw = None

HERE = os.path.dirname(os.path.abspath(__file__))
SHEETS = os.path.join(HERE, "..", "..", "..", "assets-src", "studies", "cave-sheets", "sheets")
OUT = os.path.join(HERE, "out", "moss")
REFS = [
    ("reference: rock-a crown (Tris's crop)", os.path.join(OUT, "ref_crown.png"), None),
    ("reference: mid-ledge, top", "mid_ledge_rock_asset_sheet.png", (640, 100, 1200, 600)),
    ("reference: rock-a, 3/4", "mossy_boulder_turnaround_sheet.png", (660, 640, 1200, 1150)),
    ("reference: rock-a, top", "mossy_boulder_turnaround_sheet.png", (680, 90, 1180, 570)),
]


def moss_bands(im):
    """(shade, mid, lit) RGB triples of the moss pixels of a PIL image, or None if too few."""
    return bands_of(np.asarray(im.convert("RGB")).astype(float) / 255)


def bands_of(a):
    """`a` is an (h, w, 3) float array of sRGB in 0..1."""
    mx, mn = a.max(2), a.min(2)
    v = mx
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    d = np.maximum(mx - mn, 1e-6)
    h = np.where(mx == g, (b - r) / d + 2, np.where(mx == r, ((g - b) / d) % 6, (r - g) / d + 4)) / 6
    moss = (h > 0.14) & (h < 0.42) & (s > 0.3) & (v > 0.2) & (g > r)
    if moss.sum() < 500:
        return None
    px = a[moss] * 255
    vv = v[moss]
    out = []
    for lo, hi in ((0, 20), (40, 60), (85, 100)):
        p0, p1 = np.percentile(vv, [lo, hi])
        sel = (vv >= p0) & (vv <= p1)
        out.append(tuple(int(round(x)) for x in px[sel].mean(0)))
    return out


def main(surfaces, out_name="cmp_moss.png"):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from grid import F
    size = 420
    cols = 4
    rows = [[(label, Image.open(f if os.path.isabs(f) else os.path.join(SHEETS, f)).crop(box) if box else Image.open(f)) for label, f, box in REFS]]
    for sname in surfaces:
        row = []
        for view in ("3q", "top", "close"):
            path = os.path.join(OUT, "%s_%s.png" % (sname, view))
            if os.path.exists(path):
                row.append(("%s: %s" % (sname, view), Image.open(path)))
        if row:
            rows.append(row)
    W = size * cols + 10 * (cols - 1)
    H = (size + 30) * len(rows) + 10 * (len(rows) - 1)
    c = Image.new("RGB", (W, H), (24, 30, 36))
    d = ImageDraw.Draw(c)
    for j, row in enumerate(rows):
        for i, (label, im) in enumerate(row):
            im = im.convert("RGB")
            w, h = im.size
            m = min(w, h)
            im = im.crop(((w - m) // 2, (h - m) // 2, (w + m) // 2, (h + m) // 2)).resize((size, size), Image.LANCZOS)
            x, y = i * (size + 10), j * (size + 40)
            d.text((x + 8, y + 6), label, fill=(230, 230, 230), font=F)
            c.paste(im, (x, y + 30))
    out = os.path.join(OUT, out_name)
    c.save(out, optimize=True)
    print(out)

    print("%-22s %-16s %-16s %-16s" % ("", "shade", "mid", "lit"))
    for label, im in rows[0][:1]:
        print("%-22s %-16s %-16s %-16s" % ("reference", *moss_bands(im)))
    for row in rows[1:]:
        for label, im in row:
            if label.endswith("3q"):
                b = moss_bands(im)
                print("%-22s %-16s %-16s %-16s" % ((label.split(":")[0],) + (tuple(b) if b else ("-", "-", "-"))))


if __name__ == "__main__":
    names = sys.argv[1:]
    out_name = "cmp_moss.png"
    if names and names[0].endswith(".png"):
        out_name, names = names[0], names[1:]
    main(names or ["sludge", "paint", "kuwahara", "toon"], out_name)
