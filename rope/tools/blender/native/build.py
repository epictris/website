"""Build the native kernel library (tools/blender/native/src) with the
system g++ and OpenMP:

    python3 tools/blender/native/build.py     (bun run native:build)

The library is named by its sources' hash and carries it (`rk_source_hash`),
so the loader (__init__.py) only ever loads one built from the sources beside
it, and builds it first when it is missing. Every translation unit compiles
on its own thread; ours with every warning an error, the vendored libraries
(third_party/, each with its LICENSE and VERSION) as their authors ship them.
Plain Python: it runs under the system interpreter or Blender's alike."""

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "src"
THIRD_PARTY = HERE / "third_party"
OUT = HERE / "build"
# Blender bundles no libstdc++ or libgomp: both load the system's.
FLAGS = ["-std=c++17", "-O3", "-march=native", "-fopenmp", "-fPIC"]
OURS = ["-Wall", "-Wextra", "-Werror"]
VENDORED = ["-w"]
# Vendored translation units, compiled beside ours (none: CDT is headers).
VENDORED_UNITS = []
INCLUDES = [f"-I{SRC}", f"-isystem{THIRD_PARTY / 'cdt'}"]


def sources():
    return sorted(p for p in SRC.rglob("*") if p.suffix in (".cpp", ".h", ".hpp"))


def hashed():
    """Everything the library is built from: our sources and the vendored
    ones they include or compile."""
    return sorted([*sources(), *(p for p in THIRD_PARTY.rglob("*") if p.is_file())])


def source_hash():
    h = hashlib.sha256()
    h.update(" ".join(FLAGS + OURS + VENDORED + INCLUDES).encode())
    for p in hashed():
        h.update(str(p.relative_to(HERE)).encode())
        h.update(p.read_bytes())
    return h.hexdigest()[:16]


def library_path(digest=None):
    return OUT / f"librk-{digest or source_hash()}.so"


def build(quiet=False):
    """Build the library for the current sources (if not built yet) and
    return its path. Written to a temporary name and renamed, so a Blender
    loading it meanwhile never sees half a file."""
    digest = source_hash()
    path = library_path(digest)
    if path.exists():
        return path
    compiler = shutil.which("g++")
    if compiler is None:
        raise RuntimeError("the native kernels need g++ (dnf install gcc-c++)")
    OUT.mkdir(exist_ok=True)
    if not quiet:
        print(f"[native] building {path.name}", flush=True)
    with tempfile.TemporaryDirectory(dir=OUT) as work:
        units = [(p, OURS) for p in sources() if p.suffix == ".cpp"] + [(p, VENDORED) for p in VENDORED_UNITS]

        def compile_unit(unit):
            src, warnings = unit
            obj = Path(work) / f"{src.stem}.o"
            run = subprocess.run([compiler, *FLAGS, *warnings, f'-DRK_SOURCE_HASH="{digest}"', *INCLUDES,
                                  "-c", str(src), "-o", str(obj)], capture_output=True, text=True)
            return obj, run

        # Respect a bounded export/preview's CPU affinity during compilation too.
        workers = len(os.sched_getaffinity(0)) if hasattr(os, 'sched_getaffinity') else os.cpu_count()
        with ThreadPoolExecutor(max_workers=workers) as pool:
            done = list(pool.map(compile_unit, units))
        failed = [run.stderr for _, run in done if run.returncode != 0]
        if failed:
            raise RuntimeError("the native kernels did not build:\n" + "\n".join(failed))
        tmp = Path(work) / "lib.so"
        run = subprocess.run([compiler, *FLAGS, "-shared", *[str(o) for o, _ in done], "-o", str(tmp)],
                             capture_output=True, text=True)
        if run.returncode != 0:
            raise RuntimeError(f"the native kernels did not link:\n{run.stderr}")
        os.replace(tmp, path)
    # Libraries from older sources.
    for old in OUT.glob("librk-*.so"):
        if old != path:
            old.unlink(missing_ok=True)
    return path


if __name__ == "__main__":
    try:
        print(build())
    except RuntimeError as e:
        sys.exit(str(e))
