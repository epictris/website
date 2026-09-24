"""Tileable PBR texture set for stratified rock (slate / basalt column).

Pure numpy (no PIL, bpy or scipy), so it imports inside Blender's bundled
Python and under the system python3 alike.

    import rocktex
    rocktex.generate("/tmp/rocktex", seed=0, size=1024)
    # -> {"albedo": ".../albedo.png", "normal": ".../normal.png",
    #     "roughness": ".../roughness.png"}

What it makes: dark grey rock with fine vertical flowing striations (grain
running along v like wood grain, gently wandering), a few thin vertical cracks
that are darker with a warm rust tint and a faint rust stain around them, and
a slightly lighter dusty tone on the flat faces between cracks.

Layers (all built in tile coordinates u, v in [0, 1)):
  - warp: low-frequency periodic fBm that shifts u, so streaks and cracks wander.
  - grain: anisotropic periodic fBm, lattice period 6-12x finer along u than
    along v, contrast-shaped into readable streaks (~1-3 cm wide).
  - tone: low-frequency isotropic fBm for broad value variation.
  - cracks: periodic polylines x = x0 + sum(sin(2 pi k v)) + jitter in warped u,
    each gated into segments by a 1D periodic noise along v, 2-5 mm wide.
  - faces: distance to the nearest crack; far from cracks reads dustier.

Tileability: every noise samples a random lattice whose indices wrap with %,
and every crack path is a sum of whole-period sinusoids / periodic noise, so
all layers and their sums are exactly periodic in u and v. Derivatives for the
normal map use np.roll, so the edge pixels see their wrapped neighbours.

Conventions:
  - One tile = 1 metre square in the game (1 px = 1 mm at size 1024). Crack
    widths and heights are authored in metres, so sizes other than 1024 keep
    the same physical look (cracks just get thinner in pixels).
  - Albedo is authored in linear RGB (mostly 0.10-0.30) and written sRGB-encoded.
  - Normal map is tangent space, OpenGL convention (+Y = image up, as glTF
    expects), stored as n * 0.5 + 0.5, Z positive. Cracks are grooves,
    striations are shallow ridges.
  - Roughness is linear greyscale, ~0.80-0.95 (lower on faces, higher in cracks).

Preview: run `python3 rocktex.py OUT_DIR [seed] [size]` and open the PNGs; to
check the seams, tile albedo.png 2x2 (np.tile on the decoded array, or any
image viewer's tile mode).
"""

import os
import struct
import sys
import zlib

import numpy as np

# Physical scale: heights in metres over a 1 m tile.
CRACK_DEPTH = 0.0025
GRAIN_HEIGHT = 0.0007
TONE_HEIGHT = 0.0015
CRACK_TINT = np.array([0.20, 0.14, 0.09])
RUST_STAIN = np.array([0.26, 0.19, 0.13])
ROCK_TINT = np.array([0.97, 1.0, 1.03])


# --- periodic noise ---------------------------------------------------------

def _smooth(t):
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)


def _lattice(g, u, v):
    """Value noise on lattice g (shape pv x pu), periodic with period 1 in u, v."""
    pv, pu = g.shape
    x = u * pu
    y = v * pv
    xf = np.floor(x)
    yf = np.floor(y)
    tx = _smooth(x - xf)
    ty = _smooth(y - yf)
    x0 = xf.astype(np.int64) % pu
    y0 = yf.astype(np.int64) % pv
    x1 = (x0 + 1) % pu
    y1 = (y0 + 1) % pv
    a = g[y0, x0] + (g[y0, x1] - g[y0, x0]) * tx
    b = g[y1, x0] + (g[y1, x1] - g[y1, x0]) * tx
    return a + (b - a) * ty


def _fbm(rng, u, v, pu, pv, octaves, gain=0.5):
    """Periodic fBm in [0, 1] (mean ~0.5); each octave doubles both periods."""
    total = np.zeros(np.broadcast_shapes(np.shape(u), np.shape(v)))
    amp = 1.0
    norm = 0.0
    for o in range(octaves):
        g = rng.random((pv << o, pu << o))
        total += amp * _lattice(g, u, v)
        norm += amp
        amp *= gain
    return total / norm


def _smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


# --- layers -----------------------------------------------------------------

def _cracks(rng, uw, v1d, count, width_range, px):
    """Crack groove amount (0..1) and distance (m) to the nearest crack.

    uw: warped u (size x size); v1d: v per row (size x 1).
    """
    groove = np.zeros_like(uw)
    nearest = np.full_like(uw, 0.5)
    zero = np.zeros_like(v1d)
    for _ in range(count):
        x0 = rng.random()
        path = np.full_like(v1d, x0)
        for k in range(1, 5):
            path += rng.normal(0.0, 0.012 / k) * np.sin(2 * np.pi * (k * v1d + rng.random()))
        path += 0.0015 * (_fbm(rng, zero, v1d, 1, 48, 2) - 0.5) * 2
        gate = _smoothstep(0.42, 0.52, _fbm(rng, zero, v1d, 1, rng.integers(2, 5), 3))
        if rng.random() < 0.3:
            gate = np.maximum(gate, 0.7)
        w0 = rng.uniform(*width_range)
        width = w0 * (0.6 + 0.8 * _fbm(rng, zero, v1d, 1, 24, 2))
        width = np.maximum(width, 1.0 / px)  # never thinner than a pixel
        d = np.abs((uw - path + 0.5) % 1.0 - 0.5)
        groove = np.maximum(groove, np.clip(1.0 - d / width, 0.0, 1.0) ** 1.5 * gate)
        nearest = np.minimum(nearest, d + (1.0 - gate) * 0.04)
    return groove, nearest


def _layers(seed, size):
    rng = np.random.default_rng(seed)
    c = np.arange(size) / size
    u = np.broadcast_to(c[None, :], (size, size))
    v = np.broadcast_to(c[:, None], (size, size))

    warp = (_fbm(rng, u, v, 3, 2, 3) - 0.5) * 0.06
    uw = u + warp

    # Streaks: along-u period 48 (2 cm cells), along-v period 5 (~10x longer).
    s = _fbm(rng, uw, v, 48, 5, 3, gain=0.55)
    s = _smoothstep(0.3, 0.7, s)
    # Thin crisp lines: ridged noise, sharpened so only the ridge crests show.
    ridge = (1.0 - np.abs(_fbm(rng, uw, v, 64, 7, 2) * 2 - 1)) ** 6
    fine = _fbm(rng, uw, v, 160, 16, 2)
    # Laminae: parallel bands along warped u (integer count keeps it periodic),
    # their phase pushed around by fBm so band widths vary from ~1 to ~3 cm.
    phase = 45.0 * uw + 6.0 * _fbm(rng, uw, v, 8, 1, 3)
    lam = _smoothstep(0.55, 0.95, 0.5 + 0.5 * np.sin(2 * np.pi * phase))
    lam *= _smoothstep(0.35, 0.65, _fbm(rng, uw, v, 10, 2, 2))
    grain = 0.45 * s + 0.25 * lam + 0.18 * ridge + 0.12 * fine

    tone = _fbm(rng, u, v, 3, 3, 4)
    tone_v = _fbm(rng, uw, v, 12, 2, 2)  # vertical bands of value

    groove_a, near_a = _cracks(rng, uw, c[:, None], 7, (0.0020, 0.0035), size)
    groove_b, near_b = _cracks(rng, uw, c[:, None], 8, (0.0010, 0.0016), size)
    groove = np.maximum(groove_a, 0.6 * groove_b)
    nearest = np.minimum(near_a, near_b * 1.6)
    halo = np.exp(-nearest / 0.004) * (1.0 - groove)
    face = _smoothstep(0.004, 0.03, nearest)
    return grain, tone, tone_v, groove, halo, face


# --- maps -------------------------------------------------------------------

def _albedo(grain, tone, tone_v, groove, halo, face):
    lum = (0.15
           + 0.05 * (tone - 0.5) * 2
           + 0.025 * (tone_v - 0.5) * 2
           + 0.06 * (grain - 0.5) * 2
           + 0.04 * face)
    rgb = lum[..., None] * ROCK_TINT
    stain = (0.5 * halo)[..., None]
    rgb = rgb + (RUST_STAIN * (lum / 0.2)[..., None] - rgb) * stain
    g = groove[..., None]
    rgb = rgb + (CRACK_TINT * (0.7 + 0.3 * tone[..., None]) - rgb) * g
    return np.clip(rgb, 0.0, 1.0)


def _height(grain, tone, groove):
    return GRAIN_HEIGHT * grain + TONE_HEIGHT * tone - CRACK_DEPTH * groove


def _normal(h, size):
    # Slope per metre; the image is 1 m, so one pixel is 1/size m.
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * (size / 2.0)
    # +Y is image up (row - 1), so d/dy = h[row-1] - h[row+1].
    dy = (np.roll(h, 1, axis=0) - np.roll(h, -1, axis=0)) * (size / 2.0)
    n = np.stack([-dx, -dy, np.ones_like(h)], axis=-1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def _roughness(grain, groove, face):
    return np.clip(0.89 - 0.05 * face + 0.06 * groove + 0.02 * (grain - 0.5), 0.0, 1.0)


def linear_to_srgb(x):
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(np.maximum(x, 0.0031308), 1 / 2.4) - 0.055)


def _q8(x):
    return (np.clip(x, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


# --- PNG --------------------------------------------------------------------

def write_png(path, img):
    """Write uint8 array (H x W greyscale or H x W x 3 RGB) as a PNG."""
    img = np.ascontiguousarray(img, dtype=np.uint8)
    h, w = img.shape[:2]
    colour = 2 if img.ndim == 3 else 0
    rows = img.reshape(h, -1)
    raw = np.hstack([np.zeros((h, 1), np.uint8), rows]).tobytes()

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, colour, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 6)))
        f.write(chunk(b"IEND", b""))


# --- entry ------------------------------------------------------------------

def build(seed=0, size=1024):
    """Return float maps: albedo (linear RGB), normal (unit XYZ), roughness, height (m)."""
    grain, tone, tone_v, groove, halo, face = _layers(seed, size)
    h = _height(grain, tone, groove)
    return {
        "albedo": _albedo(grain, tone, tone_v, groove, halo, face),
        "normal": _normal(h, size),
        "roughness": _roughness(grain, groove, face),
        "height": h,
    }


def generate(out_dir, seed=0, size=1024):
    os.makedirs(out_dir, exist_ok=True)
    maps = build(seed, size)
    paths = {k: os.path.join(out_dir, k + ".png") for k in ("albedo", "normal", "roughness")}
    write_png(paths["albedo"], _q8(linear_to_srgb(maps["albedo"])))
    write_png(paths["normal"], _q8(maps["normal"] * 0.5 + 0.5))
    write_png(paths["roughness"], _q8(maps["roughness"]))
    return paths


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "rocktex-out"
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    size = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
    print(generate(out, seed, size))
