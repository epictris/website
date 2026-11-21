"""Offline detail budgets for the game's fixed, head-on camera.

Pure Python policy shared by the exporter and the visual prototype.
Coordinates are Blender world metres: +Y behind the gameplay plane at Y=0.
"""
from dataclasses import dataclass
import math
from pathlib import Path
import re


def high_dof():
    """Read the renderer's constants, without importing Blender or the exporter."""
    source = (Path(__file__).resolve().parents[3] / "src/render3d/depthOfField.ts").read_text()
    table = re.search(r"DOF_MAX_BLUR[^=]*=\s*\{([^}]+)\}", source).group(1)
    return (float(re.search(r"high:\s*([\d.]+)", table).group(1)),
            float(re.search(r"FOCUS_BAND\s*=\s*([\d.]+)", source).group(1)))


@dataclass(frozen=True)
class Band:
    near: float
    far: float
    level: int
    geometry_error: float
    texels_per_metre: float
    blur_diameter: float


@dataclass(frozen=True)
class Budget:
    distance: float
    tan_half: float
    max_blur: float
    focus_band: float
    height: int = 2160
    base_texels: float = 512.0
    # Starting hypotheses, not a proven perceptual error bound. Retain eight
    # samples across the blur diameter and use half a sharp pixel for geometry.
    blur_samples: float = 8.0
    sharp_error_pixels: float = 0.5

    def __post_init__(self):
        for name in ("distance", "tan_half", "height", "base_texels", "blur_samples", "sharp_error_pixels"):
            value = getattr(self, name)
            if not math.isfinite(value) or value <= 0:
                raise ValueError(f"{name} must be positive and finite")
        if not 0 <= self.max_blur < 1 or not math.isfinite(self.focus_band) or self.focus_band < 0:
            raise ValueError("Invalid depth of field settings")

    @property
    def plane_pixel(self):
        return 2 * self.distance * self.tan_half / self.height

    def blur(self, y):
        return 4 * self.max_blur * self.tan_half * max(0.0, y - self.focus_band)

    def footprint(self, y):
        if not math.isfinite(y) or y <= -self.distance:
            raise ValueError("Surface must be in front of the camera")
        return max(2 * (self.distance + y) * self.tan_half / self.height,
                   self.blur(y) / self.blur_samples)

    def level(self, y):
        # Floor, never round up: each band is at least as fine as requested.
        return math.floor(math.log2(self.footprint(y) / self.plane_pixel) + 1e-12)

    def transition(self, level):
        """World Y at which the permissible footprint first reaches 2**level."""
        factor = 2.0 ** level
        perspective = self.distance * (factor - 1)
        blurred = (self.focus_band + factor * self.plane_pixel * self.blur_samples /
                   (4 * self.max_blur * self.tan_half)) if self.max_blur else math.inf
        return min(perspective, blurred)

    def bands(self, near, far, max_bands=16):
        self.footprint(near)
        self.footprint(far)
        if far < near:
            raise ValueError("Reversed depth range")
        level = self.level(near)
        result = []
        while True:
            end = min(far, self.transition(level + 1))
            factor = 2.0 ** level
            result.append(Band(near, end, level,
                               self.sharp_error_pixels * self.plane_pixel * factor,
                               self.base_texels / factor, self.blur(near)))
            if end >= far:
                return result
            if len(result) >= max_bands:
                raise ValueError("Too many depth bands; review the camera/range before generating")
            near, level = end, level + 1
