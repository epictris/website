"""HDR bake denoising using Blender's bundled Open Image Denoise library.

Cycles render denoising does not run on texture bakes. Denoise the linear
irradiance before HDR scaling/8-bit encoding, never the rock's colour texture.
API: https://www.openimagedenoise.org/documentation.html#rt
"""
import ctypes as c
import ctypes.util
from pathlib import Path

import bpy
import numpy as np


class LightmapDenoiser:
    def __init__(self):
        root = Path(bpy.app.binary_path).parent
        paths = [*root.glob("lib/libOpenImageDenoise.so*"),
                 *root.glob("OpenImageDenoise.dll"),
                 *root.glob("../Resources/lib/libOpenImageDenoise*.dylib")]
        path = str(paths[0]) if paths else ctypes.util.find_library("OpenImageDenoise")
        if not path:
            raise RuntimeError("Open Image Denoise library not found beside Blender")
        self.lib = lib = c.CDLL(path)
        self.device = None
        signatures = {
            "oidnNewDevice": (c.c_void_p, [c.c_int]),
            "oidnCommitDevice": (None, [c.c_void_p]),
            "oidnReleaseDevice": (None, [c.c_void_p]),
            "oidnGetDeviceError": (c.c_int, [c.c_void_p, c.POINTER(c.c_char_p)]),
            "oidnNewFilter": (c.c_void_p, [c.c_void_p, c.c_char_p]),
            "oidnSetSharedFilterImage": (None, [c.c_void_p, c.c_char_p, c.c_void_p, c.c_int,
                                                c.c_size_t, c.c_size_t, c.c_size_t, c.c_size_t, c.c_size_t]),
            "oidnSetFilterInt": (None, [c.c_void_p, c.c_char_p, c.c_int]),
            "oidnSetFilterBool": (None, [c.c_void_p, c.c_char_p, c.c_bool]),
            "oidnCommitFilter": (None, [c.c_void_p]),
            "oidnExecuteFilter": (None, [c.c_void_p]),
            "oidnReleaseFilter": (None, [c.c_void_p]),
        }
        for name, (result, args) in signatures.items():
            fn = getattr(lib, name)
            fn.restype, fn.argtypes = result, args
        # CPU shared memory avoids duplicating all the bake textures on GPU.
        self.device = lib.oidnNewDevice(1)
        self.check()
        lib.oidnCommitDevice(self.device)
        self.check()

    def check(self):
        message = c.c_char_p()
        if self.lib.oidnGetDeviceError(self.device, c.byref(message)):
            raise RuntimeError(f"Lightmap denoising: {message.value.decode() if message.value else 'unknown error'}")

    def apply(self, pixels):
        if pixels.dtype != np.float32 or not pixels.flags.c_contiguous or pixels.ndim != 3 or pixels.shape[2] != 4:
            raise ValueError("Lightmap denoising requires contiguous float32 RGBA")
        if not np.isfinite(pixels).all():
            raise ValueError("Non-finite lightmap before denoising")
        if not pixels[:, :, :3].any():
            return  # A truly unlit surface remains exactly black.
        height, width = pixels.shape[:2]
        # Blender bundles the RT weights, but not RTLightmap's optional model.
        filt = self.lib.oidnNewFilter(self.device, b"RT")
        self.check()
        try:
            for name in (b"color", b"output"):
                self.lib.oidnSetSharedFilterImage(filt, name, pixels.ctypes.data, 3,
                                                 width, height, 0, 16, width * 16)
            self.lib.oidnSetFilterInt(filt, b"maxMemoryMB", 512)
            self.lib.oidnSetFilterBool(filt, b"hdr", True)
            self.lib.oidnCommitFilter(filt)
            self.check()
            self.lib.oidnExecuteFilter(filt)
            self.check()
            np.maximum(pixels[:, :, :3], 0, out=pixels[:, :, :3])
        finally:
            self.lib.oidnReleaseFilter(filt)

    def close(self):
        if self.device:
            self.lib.oidnReleaseDevice(self.device)
            self.device = None
