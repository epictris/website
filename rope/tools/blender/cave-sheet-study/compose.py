"""Side-by-side: reference crop (left) | local replication (right).

The reference sheets are published sources (`just sources` fetches them into
rope/assets-src/studies/cave-sheets/, see docs/cave-look.md); nothing here is
read from the study directory but the renders in out/.
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

SRC = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "assets-src", "studies", "cave-sheets"))
SHEETS = os.path.join(SRC, "sheets") + "/"
TEXTURE = os.path.join(SRC, "texture") + "/"
ROCK_B = os.path.join(SHEETS, "mossy_rock_asset_sheet_views.png")
ROCK_B_3Q = (627, 627, 1254, 1254)  # the 3/4 panel of the four-view sheet

try:
    FONT = ImageFont.truetype("/usr/share/fonts/google-noto/NotoSans-Regular.ttf", 20)
except Exception:
    FONT = ImageFont.load_default()


def pair(ref_path, ren_path, out_path, label_l="reference", label_r="Blender replication", size=560, crop=None):
    ref = Image.open(ref_path).convert("RGB")
    if crop:
        ref = ref.crop(crop)
    ref = ref.resize((size, size), Image.LANCZOS)
    ren = Image.open(ren_path).convert("RGB").resize((size, size), Image.LANCZOS)
    gap = 12
    canvas = Image.new("RGB", (size * 2 + gap, size + 34), (24, 30, 36))
    canvas.paste(ref, (0, 34))
    canvas.paste(ren, (size + gap, 34))
    d = ImageDraw.Draw(canvas)
    d.text((8, 7), label_l, fill=(210, 215, 220), font=FONT)
    d.text((size + gap + 8, 7), label_r, fill=(210, 215, 220), font=FONT)
    canvas.save(out_path, optimize=True)
    print(out_path)


def sheet(ref_sheet, renders, out_path, size=480):
    """Reference sheet's four views beside the four rendered views."""
    ref = Image.open(ref_sheet).convert("RGB")
    boxes = {"front": (0, 0, 627, 627), "top": (627, 0, 1254, 627), "side": (0, 627, 627, 1254), "3q": (627, 627, 1254, 1254)}
    gap = 10
    canvas = Image.new("RGB", (size * 4 + gap * 3, size * 2 + gap + 34), (24, 30, 36))
    d = ImageDraw.Draw(canvas)
    d.text((8, 7), "reference (top row) vs Blender replication (bottom row): front, top, right side, 3/4", fill=(210, 215, 220), font=FONT)
    for i, k in enumerate(["front", "top", "side", "3q"]):
        canvas.paste(ref.crop(boxes[k]).resize((size, size), Image.LANCZOS), (i * (size + gap), 34))
        canvas.paste(Image.open(renders[k]).convert("RGB").resize((size, size), Image.LANCZOS), (i * (size + gap), 34 + size + gap))
    canvas.save(out_path, optimize=True)
    print(out_path)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "out"
    R = SHEETS
    pair(ROCK_B, f"{out}/1_facets.png", f"{out}/cmp_1_facets.png", "reference: rock-b 3/4", "Blender: faceted hulls, flat grey", crop=ROCK_B_3Q)
    pair(R + "mossy_boulder_turnaround_sheet.png", f"{out}/2_surface.png", f"{out}/cmp_2_surface.png", "reference: rock-a front, rock surface", "Blender: mosaic stone shader", crop=(120, 120, 560, 560))
    pair(R + "mid_ledge_rock_asset_sheet.png", f"{out}/3_moss.png", f"{out}/cmp_3_moss.png", "reference: mid-ledge, moss carpet", "Blender: moss shell", crop=(640, 100, 1200, 600))
    pair(R + "mossy_cave_roof_asset_turnaround.png", f"{out}/4_vines.png", f"{out}/cmp_4_vines.png", "reference: roof, hanging vines", "Blender: vines", crop=(40, 120, 620, 600))
    pair(R + "mossy_boulder_turnaround_sheet.png", f"{out}/5_plants.png", f"{out}/cmp_5_plants.png", "reference: rock-a, ferns and clover", "Blender: ferns, clover, broadleaf", crop=(40, 320, 620, 560))
    pair(R + "mossy_rock_shelf_asset_sheet.png", f"{out}/6_mushrooms.png", f"{out}/cmp_6_mushrooms.png", "reference: left-shelf, mushrooms", "Blender: mushrooms", crop=(120, 120, 620, 620))
    sheet(R + "mossy_rock_asset_sheet_views.png", {k: f"{out}/7_sheet_{k}.png" for k in ["front", "top", "side", "3q"]}, f"{out}/cmp_7_sheet.png")
