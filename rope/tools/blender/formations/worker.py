"""Build one formation rock from a recipe, outside the artist's Blender.

    python worker.py input.json OUT_DIR --blender BLENDER

Run with ORDINARY Python (rope/.venv: numpy, scipy, shapely), never Blender's:
the boulder generator (tools/blender/boulders, unmodified) cuts the outline
into slabs here, and a headless Blender (`assemble.py`) joins them into
`OUT_DIR/rock.blend`, which the Formations panel then validates and swaps in.
The fitted slate generator (`fitted.py`) needs nothing here: it is built
entirely in that headless Blender.
Running out of process is what keeps the artist's scene editable, and
cancellable, while a rock builds.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GENERATOR = HERE.parent / "boulders"

# Starting outlines (rock-local X/Z, metres) and depths for a rock created
# without one. Every one is only a start: the outline is edited afterwards.
PRESETS = {
    "terrace": {"outline": [[-1.65, 3.35], [-.8, 3.48], [.55, 3.42], [1.65, 3.25], [1.52, 2.45], [1.23, .8],
                            [1.1, -1.45], [.88, -3.7], [-.78, -3.8], [-1.04, -2.1], [-1.2, .05], [-1.47, 1.9]],
                "depth": 1.55},
    "pillar": {"outline": [[-.7, 1.9], [.6, 1.8], [.85, .6], [.6, -1.9], [-.8, -1.8], [-.92, -.2]], "depth": 1.3},
    "wall": {"outline": [[-1.45, 1.9], [1.3, 2.0], [1.6, .5], [1.35, -1.8], [-1.4, -2.0], [-1.65, .0]], "depth": 1.5},
    "arch": {"outline": [[-2.1, .7], [-.6, 1.05], [1, .83], [2.1, .4], [1.8, -.6], [.5, -.15], [-.6, -.3], [-1.95, -.65]],
             "depth": 1.2},
    "distant": {"outline": [[-.95, 1.7], [.85, 1.65], [1.1, .2], [.65, -1.8], [-.8, -1.7], [-1.15, .1]], "depth": 1.0},
}

# The generator's parameters: its own defaults (boulders/params.json), the
# construction the editor's boulder service built from 2026-09-25. A recipe's
# own `params` override these; `tolerance` is left out so the generator derives
# it from the outline, as it did there. Karin's scenery adapter (slabsPerArea
# 1.3, faceBudget 1000, detail 0.25, voxelCap 0.045, tolerance 0.07, weathering
# 0.25), the default from 2026-09-29, cut a formation into a few big, softly
# remeshed chunks; Tris prefers the many crisp slabs (2026-10-04). Its material
# parameters are not here: a formation's stone is the painted slate
# (slate.py), not the generator's tinted stones.
DEFAULT_PARAMS = {
    "seed": 31, "slabsPerArea": 10, "faceBudget": 3000, "detail": 1, "voxelCap": .012, "weathering": .38,
    "edgeBevelWidth": .0002, "slabWidth": 1.5015, "slabLength": .434,
}

# A slab's width and length, metres, about their middles (`slabWidth`,
# `slabLength`): the generator's own ranges, as shares of their middles. They
# were 29-48 % of the outline's width and 19-43 % of its height until
# 2026-10-16; the defaults are what that came to on Terrace.003 (3.9 x 1.4 m),
# and an older rock's are read off its own outline (`legacy_slab_size`).
SLAB_WIDTH_SPREAD = (.29 / .385, .48 / .385)
SLAB_LENGTH_SPREAD = (.19 / .31, .43 / .31)


def legacy_slab_size(outline):
    """The slab width and length a recipe from before version 2 was built
    with: the middles of the shares of its outline's extent."""
    xs, ys = [p[0] for p in outline], [p[1] for p in outline]
    return .385 * (max(xs) - min(xs)), .31 * (max(ys) - min(ys))

# What builds the rock, by the recipe's `generator` (a recipe without one is
# the boulder generator's): its parameters and their defaults. `fitted` is
# recipe F's rocks fitted to the outline and fused (fitted.py); a rock's long
# half-length runs from `smallestRock` to `largestRock`, in metres.
GENERATORS = {
    "boulders": DEFAULT_PARAMS,
    "fitted": {"seed": 31, "smallestRock": 0.25, "largestRock": 3.0},
    # Recipe F stones cut from a closed guide mesh instead of an outline
    # (solidfit.py; the backdrop, docs/blender-backdrop.md). Its defaults
    # are solidfit.PARAMS, repeated here because this runs outside Blender.
    "solid": {"seed": 0, "stoneSize": 1.0, "facets": 0.55, "chisel": 0.25, "knub": 0.3, "curveTurn": 60.0,
              "floor": 0.0, "fixedScale": 0.0, "facetFalloff": 1.0},
}


# A recipe's version. Version 2 (2026-10-16): a boulder recipe's `depth` is the
# rock's thickness. Before it, it was the boulder construction's depth, a
# LEGACY_THICKNESS-th of the thickness (twice boulders/rockgen.ENVELOPE), and
# params.built reads an older recipe's depth as that many times thicker.
RECIPE_VERSION = 2
LEGACY_THICKNESS = 2.6


def fingerprint():
    """What built the rock: this adapter and the generators, byte for byte."""
    h = hashlib.sha256()
    for p in [Path(__file__), HERE / "assemble.py", HERE / "fitted.py", HERE / "solidfit.py", HERE / "slate.py",
              *sorted(GENERATOR.glob("*.py")), GENERATOR / "params.json"]:
        h.update(p.name.encode())
        h.update(p.read_bytes())
    return h.hexdigest()


def prepare(recipe, output):
    if recipe.get("generator") == "solid":
        # All Blender, from the recipe's own guide, camera and frame.
        given = {k: v for k, v in recipe.get("params", {}).items() if k in GENERATORS["solid"]}
        resolved = {"version": RECIPE_VERSION, "generator": "solid", "guide": recipe["guide"],
                    "camera": recipe["camera"], "frame": recipe["frame"], "params": {**GENERATORS["solid"], **given},
                    "generatorHash": fingerprint()}
        (output / "recipe.json").write_text(json.dumps(resolved, separators=(",", ":")))
        return
    kind = recipe.get("preset", "terrace")
    base = PRESETS[kind]
    generator = recipe.get("generator", "boulders")
    defaults = GENERATORS[generator]
    # Only the chosen generator's parameters: a rebuild that switches
    # generator does not carry the other's into the recipe.
    given = {k: v for k, v in recipe.get("params", {}).items() if k in defaults or k == "depth"}
    params = {**defaults, "depth": base["depth"], **given}
    outline = recipe.get("outline", base["outline"])
    # A boulder recipe from before version 2, regenerated with none of its
    # fields changed (core.recipe_for), is built as it was first built: its
    # depth the construction's, its slabs and core shares of its outline, its
    # faces per perimeter. The least change to the slabs rearranges every
    # facet, so this is the only way it comes back as it was.
    legacy = generator == "boulders" and recipe.get("version") == 1
    if legacy:
        params = {k: v for k, v in params.items() if k not in ("slabWidth", "slabLength")}
    if generator == "boulders":
        sys.path.insert(0, str(GENERATOR))
        import rockgen

        if not math.isclose(2 * rockgen.ENVELOPE, LEGACY_THICKNESS):
            raise RuntimeError("worker.LEGACY_THICKNESS is no longer twice rockgen.ENVELOPE")
        # The generator takes the ranges; the recipe keeps the middles.
        asked = {k: v for k, v in params.items() if k not in ("slabWidth", "slabLength")}
        if not legacy:
            asked["slabWidthMin"], asked["slabWidthMax"] = (params["slabWidth"] * k for k in SLAB_WIDTH_SPREAD)
            asked["slabLengthMin"], asked["slabLengthMax"] = (params["slabLength"] * k for k in SLAB_LENGTH_SPREAD)
        source = output / "request.json"
        source.write_text(json.dumps({"outline": outline, "params": asked}))
        spec = rockgen.read_specs(source)[0]
        spec["name"] = "SceneryRock"
        if legacy:
            spec["depth"] = params["depth"]
            spec["legacy_sizing"] = True
        rock = rockgen.make_rock(spec)
        (output / "geometry.json").write_text(json.dumps({"rocks": [rock]}, separators=(",", ":")))
    # The fitted slate is all Blender: assemble.py builds it from the recipe.
    resolved = {"version": 1 if legacy else RECIPE_VERSION, "preset": kind, "generator": generator, "outline": outline,
                "params": params, "generatorHash": fingerprint()}
    (output / "recipe.json").write_text(json.dumps(resolved, indent=2))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("recipe")
    p.add_argument("output")
    p.add_argument("--blender", required=True)
    a = p.parse_args()
    output = Path(a.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    prepare(json.loads(Path(a.recipe).read_text(encoding="utf-8")), output)
    build = subprocess.run([a.blender, "--background", "--factory-startup", "--python-exit-code", "1",
                            "--python", str(HERE / "assemble.py"), "--", str(output)])
    if build.returncode:
        # Blender printed its own error above; a traceback of this call
        # would only bury it.
        sys.exit(f"assemble.py failed in Blender (exit status {build.returncode})")
    if not (output / "rock.blend").is_file():
        raise RuntimeError("Worker produced no rock.blend")


if __name__ == "__main__":
    main()
