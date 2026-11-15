"""Logarithmic HDR lightmaps transported as ordinary sRGB glTF images.

A single hot texel must not quantise the rest of a dark cave to black/blue.
Decode sRGB first, then (exp2(value * log2(1 + 16 * range)) - 1) / 16.
"""
import numpy as np

LOG_SCALE = 16.0


def encode_lightmap(rgb, peak):
    light = np.log1p(np.maximum(rgb, 0) * LOG_SCALE) / np.log1p(peak * LOG_SCALE)
    return np.where(light <= .0031308, light * 12.92,
                    1.055 * light ** (1 / 2.4) - .055)


def decode_lightmap(encoded, peak):
    light = np.where(encoded <= .04045, encoded / 12.92,
                     ((encoded + .055) / 1.055) ** 2.4)
    return np.expm1(light * np.log1p(peak * LOG_SCALE)) / LOG_SCALE
