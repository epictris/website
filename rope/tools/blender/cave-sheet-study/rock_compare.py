"""Review sheets for the rock geometry study (out/rock/*.png -> out/rock/cmp_*.png)."""
import os

from PIL import Image

from compose import ROCK_B, ROCK_B_3Q, TEXTURE, pair, sheet
from grid import tile

O = "out/rock/"
R = TEXTURE
ROCK_B_CROP = O + "reference-rock-b-3q.png"  # cut from the sheet at run time

ATTEMPTS = [
    ("reference: rock-b 3/4", ROCK_B_CROP),
    ("A  random hulls (the first report's baseline)", O + "hull_A_3q.png"),
    ("B  icosphere + cloud displace + decimate", O + "zaal_B_3q.png"),
    ("C  bevelled boxes, voxel remesh", O + "pillow_C_3q.png"),
    ("D  C + corner cuts (primary form)", O + "pillow_D_3q.png"),
    ("E  D + big noise + collapse/planar facets", O + "pillow_E_3q.png"),
    ("F  E + 80 chisel cuts/m  (CHOSEN)", O + "pillow_F_3q.png"),
    ("G  F + shallow crackle domes (rejected: too complex)", O + "pillow_best_3q.png"),
    ("F, sharper edges, painted slate shader v6", O + "pillow_v6_3q.png"),
]

TEXTURE_SHEET = [
    ("reference 3 (ball-and-chain plateau)", R + "rock-texture-ref3.png"),
    ("reference 2", R + "rock-texture-ref2.png"),
    ("v6 painted slate + warm area key  (CHOSEN)", O + "pillow_v6_3q.png"),
    ("rejected: mosaic Voronoi shader (first report)", O + "pillow_best_stone_3q.png"),
    ("rejected: v5 warm albedo (chalky)", O + "pillow_F_plain5_3q.png"),
    ("rejected: v8 orange key + blue fill (brown bounce)", O + "pillow_v8std_3q.png"),
    ("rejected: v12 sun + sky, orange sun (lavender tops)", O + "pillow_v12sky3.5_3q.png"),
    ("rejected: v13 yellow sun (olive)", O + "pillow_v13sky4_3q.png"),
    ("rejected: v14 sun straight behind (navy shade)", O + "pillow_v14_3q.png"),
]

if __name__ == "__main__":
    os.makedirs(O, exist_ok=True)
    Image.open(ROCK_B).crop(ROCK_B_3Q).save(ROCK_B_CROP)
    tile(O + "cmp_rock_attempts.png", ATTEMPTS, cols=3, size=420)
    tile(O + "cmp_texture_doc.png", TEXTURE_SHEET, cols=3, size=420)
    pair(ROCK_B_CROP, O + "pillow_v6_3q.png", O + "cmp_rock_best.png",
         "reference: rock-b 3/4", "Blender: F geometry, painted slate shader, warm key (v6)")
    pair(ROCK_B_CROP, O + "hull_A_3q.png", O + "cmp_rock_before.png",
         "reference: rock-b 3/4", "Blender: random hulls (previous report)")
    sheet(ROCK_B,
          {k: O + "pillow_v6_%s.png" % k for k in ["front", "top", "side", "3q"]},
          O + "cmp_rock_sheet.png")
