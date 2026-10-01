"""grid.py OUT.png N1 N2 ... : tile out/rock/<N>_3q.png renders, labelled."""
import sys
from PIL import Image, ImageDraw, ImageFont
try:
    F = ImageFont.truetype("/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf", 18)
except Exception:
    F = ImageFont.load_default(18)


def tile(out, items, cols=None, size=480):
    """items = [(label, path)]; square crops, labelled, tiled."""
    cols = cols or (2 if len(items) <= 4 else 3)
    rows = (len(items) + cols - 1) // cols
    c = Image.new("RGB", (size * cols + 10 * (cols - 1), (size + 30) * rows + 10 * (rows - 1)), (24, 30, 36))
    d = ImageDraw.Draw(c)
    for i, (label, path) in enumerate(items):
        im = Image.open(path).convert("RGB")
        w, h = im.size
        if w != h:
            m = min(w, h)
            im = im.crop(((w - m) // 2, (h - m) // 2, (w + m) // 2, (h + m) // 2))
        im = im.resize((size, size), Image.LANCZOS)
        x, y = (i % cols) * (size + 10), (i // cols) * (size + 40)
        d.text((x + 8, y + 6), label, fill=(230, 230, 230), font=F)
        c.paste(im, (x, y + 30))
    c.save(out, optimize=True)
    print(out)


if __name__ == "__main__":
    out, names = sys.argv[1], sys.argv[2:]
    tile(out, [(n.replace("out/rock/", ""), n if n.endswith(".png") else f"out/rock/{n}_3q.png") for n in names])
