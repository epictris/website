"""Combine the dirt-and-moss block renders (3/4 view + side view, per
block) into a single contact-sheet PNG. Standalone from the boulder v5
validators: those already produce their own generic contact_sheet.png
(reused as-is for the boulder-style per-block PASS/FAIL grid), but this one
is specific to dirt-and-moss blocks: it shows both camera angles and the
measured moss_coverage next to the requested target.

Usage: python make_contact_sheet.py <output-dir> [--out PATH]
"""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def load_font(size, bold=False):
    name = "segoeuib.ttf" if bold else "segoeui.ttf"
    path = Path("C:/Windows/Fonts") / name
    try:
        return ImageFont.truetype(str(path), size)
    except OSError:
        return ImageFont.load_default()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output_dir")
    parser.add_argument("--out")
    args = parser.parse_args()
    out = Path(args.output_dir).resolve()
    results = {r["name"]: r for r in json.loads((out / "validation.json").read_text())}
    blocks = json.loads((out / "source_geometry.json").read_text())["blocks"]
    names = [b["spec"]["name"] for b in blocks]

    cellw, cellh, header, label_h = 560, 560, 120, 70
    cols = len(names)
    sheet = Image.new("RGB", (cols * cellw, header + cellh + label_h), "#f0eee8")
    draw = ImageDraw.Draw(sheet)
    draw.text((30, 24), "DIRT AND MOSS BLOCKS", fill="#252928", font=load_font(34, True))
    draw.text((32, 70), "Procedural chunky dirt with scattered moss cushions / 3-quarter + side view",
              fill="#5a625f", font=load_font(19))

    for i, name in enumerate(names):
        x = i * cellw
        front = out / "renders" / f"{name}.png"
        side = out / "renders" / f"{name}_side.png"
        if front.exists():
            img = Image.open(front).convert("RGB").resize((cellw // 2, cellh), Image.Resampling.LANCZOS)
            sheet.paste(img, (x, header))
        if side.exists():
            img = Image.open(side).convert("RGB").resize((cellw // 2, cellh), Image.Resampling.LANCZOS)
            sheet.paste(img, (x + cellw // 2, header))
        r = results.get(name, {})
        moss = r.get("moss_coverage")
        label = name.replace("_", " ").upper()
        draw.text((x + 20, header + cellh + 8), label, font=load_font(22, True), fill="#252928")
        status = "PASS" if r.get("passed") else "FAIL"
        moss_txt = f"moss {moss:.2f}" if moss is not None else "moss n/a"
        draw.text((x + 20, header + cellh + 38),
                  f"{r.get('faces', '?'):,} tris  /  {status}  /  {moss_txt}",
                  font=load_font(17), fill="#5a625f")
    dest = Path(args.out) if args.out else out / "dirt_moss_contact_sheet.png"
    sheet.save(dest)
    print(f"Saved {dest}")


if __name__ == "__main__":
    main()
