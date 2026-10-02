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

# The generator's parameters for scenery: the approved boulder construction at
# scenery scale and detail. A recipe's own `params` override these. Its
# material parameters are not here: a formation's stone is the painted slate
# (slate.py), not the generator's tinted stones.
DEFAULT_PARAMS = {
    "seed": 31, "slabsPerArea": 1.3, "faceBudget": 1000, "detail": .25, "voxelCap": .045,
    "tolerance": .07, "weathering": .25,
}

# What builds the rock, by the recipe's `generator` (a recipe without one is
# the boulder generator's): its parameters and their defaults. `fitted` is
# recipe F's rocks fitted to the outline and fused (fitted.py); a rock's long
# half-length runs from `smallestRock` to `largestRock`, in metres.
GENERATORS = {
    "boulders": DEFAULT_PARAMS,
    "fitted": {"seed": 31, "smallestRock": 0.25, "largestRock": 3.0},
}


def fingerprint():
    """What built the rock: this adapter and the generators, byte for byte."""
    h = hashlib.sha256()
    for p in [Path(__file__), HERE / "assemble.py", HERE / "fitted.py", HERE / "slate.py",
              *sorted(GENERATOR.glob("*.py")), GENERATOR / "params.json"]:
        h.update(p.name.encode())
        h.update(p.read_bytes())
    return h.hexdigest()


def prepare(recipe, output):
    kind = recipe.get("preset", "terrace")
    base = PRESETS[kind]
    generator = recipe.get("generator", "boulders")
    defaults = GENERATORS[generator]
    # Only the chosen generator's parameters: a rebuild that switches
    # generator does not carry the other's into the recipe.
    given = {k: v for k, v in recipe.get("params", {}).items() if k in defaults or k == "depth"}
    params = {**defaults, "depth": base["depth"], **given}
    outline = recipe.get("outline", base["outline"])
    if generator == "boulders":
        sys.path.insert(0, str(GENERATOR))
        import rockgen

        source = output / "request.json"
        source.write_text(json.dumps({"outline": outline, "params": params}))
        spec = rockgen.read_specs(source)[0]
        spec["name"] = "SceneryRock"
        rock = rockgen.make_rock(spec)
        (output / "geometry.json").write_text(json.dumps({"rocks": [rock]}, separators=(",", ":")))
    # The fitted slate is all Blender: assemble.py builds it from the recipe.
    resolved = {"version": 1, "preset": kind, "generator": generator, "outline": outline, "params": params,
                "generatorHash": fingerprint()}
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
    subprocess.run([a.blender, "--background", "--factory-startup", "--python-exit-code", "1",
                    "--python", str(HERE / "assemble.py"), "--", str(output)], check=True)
    if not (output / "rock.blend").is_file():
        raise RuntimeError("Worker produced no rock.blend")


if __name__ == "__main__":
    main()
