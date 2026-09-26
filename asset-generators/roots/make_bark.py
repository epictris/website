"""
Generates the shared natural grey-brown bark sheet for the root kit.
The previous natural bark generator remains available as build_legacy().

Sheet is 2048x2048, split into FOUR vertical bands of 512x2048:
    Four variations of interrupted fibres and fissures, with independent seeds.
    Existing band UVs remain compatible.

Each band tiles seamlessly VERTICALLY (along root length, unbounded V)
and seamlessly WITHIN ITS OWN WIDTH (the tube ring closes inside one band).
So you can repaint any band without touching the others.

Outputs: bark_albedo.png, bark_height.png, bark_normal.png, bark_roughness.png
"""

import numpy as np
from PIL import Image

W, H = 2048, 2048
BANDS = 4
BW = W // BANDS          # 512


# ---------------------------------------------------------------- noise ----

def periodic_noise(h, w, fx, fy, rng, power=1.15):
    """Band-limited periodic noise via FFT filtering. Tiles exactly."""
    white = rng.standard_normal((h, w))
    F = np.fft.fft2(white)
    ky = np.fft.fftfreq(h)[:, None] * h
    kx = np.fft.fftfreq(w)[None, :] * w
    # anisotropic radius: fy stretches features along Y (bark runs lengthwise)
    r = np.sqrt((kx / fx) ** 2 + (ky / fy) ** 2)
    r[0, 0] = 1.0
    F *= 1.0 / (r ** power + 1e-6)
    F[0, 0] = 0
    out = np.real(np.fft.ifft2(F))
    return out / (np.abs(out).max() + 1e-9)


def fbm(h, w, fx, fy, rng, octaves=5, power=1.15):
    acc = np.zeros((h, w))
    amp, a, b = 1.0, fx, fy
    for _ in range(octaves):
        acc += periodic_noise(h, w, a, b, rng, power) * amp
        amp *= 0.5
        a *= 2.0
        b *= 2.0
    return acc / (np.abs(acc).max() + 1e-9)


def ridged(h, w, fx, fy, rng, octaves=4):
    n = fbm(h, w, fx, fy, rng, octaves)
    return 1.0 - np.abs(n) / (np.abs(n).max() + 1e-9)


def norm01(a):
    lo, hi = a.min(), a.max()
    return (a - lo) / (hi - lo + 1e-9)


# ---------------------------------------------------------------- bands ----

def band_young(rng):
    """Smooth, pale, fine lengthwise grain. Shallow height."""
    grain = fbm(H, BW, 26.0, 11.0, rng, 5)
    blotch = fbm(H, BW, 7.0, 5.0, rng, 4)
    height = norm01(grain * 0.7 + blotch * 0.3) * 0.45 + 0.3
    tone = norm01(blotch * 0.6 + grain * 0.4)
    base = np.array([0.44, 0.34, 0.24])
    light = np.array([0.58, 0.47, 0.34])
    alb = base + (light - base) * tone[..., None]
    alb += (grain * 0.035)[..., None]
    return alb, height


def band_cracked(rng):
    """Deep vertical fissures, the classic old-root look."""
    warp = fbm(H, BW, 10.0, 5.0, rng, 3) * 30.0
    yy, xx = np.mgrid[0:H, 0:BW]
    fis = ridged(H, BW, 13.0, 5.5, rng, 4)
    # domain-warp the fissures sideways so they wander
    idx = (xx + warp).astype(int) % BW
    fis = fis[yy, idx]
    fis = fis ** 2.2
    bark = fbm(H, BW, 40.0, 15.0, rng, 5)

    height = norm01(bark * 0.35 + (1.0 - fis) * 0.65)
    height = height ** 1.2
    tone = norm01(bark * 0.4 + (1.0 - fis) * 0.6)
    dark = np.array([0.16, 0.11, 0.075])
    mid = np.array([0.46, 0.34, 0.23])
    alb = dark + (mid - dark) * tone[..., None]
    return alb, height


def band_mossy(rng):
    """Cracked bark with green colonies. Height barely changes - moss is colour."""
    alb, height = band_cracked(np.random.default_rng(7))
    moss = norm01(fbm(H, BW, 6.0, 5.0, rng, 4))
    mask = np.clip((moss - 0.52) * 4.0, 0, 1)
    # moss settles in low areas
    mask *= np.clip(1.3 - height, 0, 1)
    speck = norm01(fbm(H, BW, 90.0, 90.0, rng, 3))
    green = np.array([0.24, 0.35, 0.16]) + (speck[..., None] - 0.5) * 0.09
    alb = alb * (1 - mask[..., None]) + green * mask[..., None]
    height = height * (1 - mask * 0.4) + (0.55 + speck * 0.2) * (mask * 0.4)
    return alb, height


def band_dry(rng):
    """Stringy, peeling, pale. Strong lengthwise fibre."""
    fibre = ridged(H, BW, 38.0, 5.0, rng, 5) ** 1.6
    peel = fbm(H, BW, 9.0, 5.0, rng, 4)
    lift = np.clip((peel - 0.15) * 2.0, 0, 1)
    height = norm01(fibre * 0.65 + lift * 0.35)
    tone = norm01(fibre * 0.5 + peel * 0.5)
    pale = np.array([0.70, 0.65, 0.55])
    shade = np.array([0.30, 0.27, 0.22])
    alb = shade + (pale - shade) * tone[..., None]
    return alb, height


# ------------------------------------------------------------- assemble ----

def build():
    from stylised_bark import sheet
    return sheet(W)


def build_legacy():
    albedo = np.zeros((H, W, 3))
    height = np.zeros((H, W))
    makers = [band_young, band_cracked, band_mossy, band_dry]
    for i, mk in enumerate(makers):
        a, h = mk(np.random.default_rng(100 + i * 13))
        albedo[:, i * BW:(i + 1) * BW] = a
        height[:, i * BW:(i + 1) * BW] = h
    return np.clip(albedo, 0, 1), np.clip(height, 0, 1)


def _blur(a, r=2):
    out = a.copy()
    for d in range(1, r + 1):
        out = out + np.roll(a, d, 0) + np.roll(a, -d, 0) + np.roll(a, d, 1) + np.roll(a, -d, 1)
    return out / (1 + 4 * r)


def height_to_normal(height, strength=5.5):
    """Per-band normal: gradients wrap within each band, not across the sheet."""
    nrm = np.zeros((H, W, 3))
    for i in range(BANDS):
        h = _blur(height[:, i * BW:(i + 1) * BW], 2)
        dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * strength
        dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * strength
        n = np.stack([-dx, -dy, np.ones_like(h)], axis=-1)
        n /= np.linalg.norm(n, axis=-1, keepdims=True)
        nrm[:, i * BW:(i + 1) * BW] = n
    return nrm * 0.5 + 0.5


def guides(img):
    """Faint band dividers baked nowhere - drawn only on a separate guide file."""
    g = img.copy()
    for i in range(1, BANDS):
        g[:, i * BW - 1:i * BW + 1] = [1.0, 0.2, 0.6]
    return g


if __name__ == "__main__":
    from pathlib import Path
    out = Path(__file__).resolve().parent
    from stylised_bark import sheet
    albedo, height, roughness = sheet(W, include_roughness=True)
    normal = height_to_normal(height, strength=12.0)
    Image.fromarray((roughness * 255).astype(np.uint8)).save(out / "bark_roughness.png")

    Image.fromarray((albedo * 255).astype(np.uint8)).save(f"{out}/bark_albedo.png")
    Image.fromarray((height * 255).astype(np.uint8)).save(f"{out}/bark_height.png")
    Image.fromarray((normal * 255).astype(np.uint8)).save(f"{out}/bark_normal.png")
    Image.fromarray((guides(albedo) * 255).astype(np.uint8)).save(
        f"{out}/bark_albedo_bandguides.png")
    print("wrote albedo / height / normal / bandguides")
