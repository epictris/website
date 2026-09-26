"""Polygon-constrained dirt-and-moss block generator. Runs in ordinary Python,
then calls Blender.

Modelled on ../boulders/stylised_rocks_v5/rockgen.py: same side-view polygon
input format, same fixed-camera silhouette contract, same
geometry-then-Blender pipeline. Shared building blocks (Mesh, prism,
triangulate_cap, camera_basis, find_blender) are imported from the boulder
v5 project rather than copied; nothing in that project is modified.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
BOULDER_ROOT = ROOT.parent / "boulders" / "stylised_rocks_v5"
sys.path.insert(0, str(BOULDER_ROOT.parent / ".deps"))
sys.path.insert(0, str(BOULDER_ROOT))
sys.path.insert(0, str(ROOT))
import numpy as np
import shapely
from shapely import Polygon
from shapely.geometry.polygon import orient

from rockgen import find_blender  # noqa: E402  (shared helper, not copied)

NAME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"


def read_specs(path):
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if data.get("plane", "CAMERA") != "CAMERA":
        raise ValueError("This generator expects side-view polygons in the CAMERA plane, as [horizontal, vertical] pairs.")
    defaults = data.get("defaults", {})
    specs = []
    names = set()
    for index, entry in enumerate(data["blocks"]):
        spec = dict(defaults, **entry)
        name = spec.setdefault("name", f"dirt_{index + 1:02d}")
        if not name or any(c not in NAME_CHARS for c in name):
            raise ValueError("Block names must contain only letters, digits, underscores, or hyphens.")
        if name in names:
            raise ValueError(f"Duplicate block name: {name}")
        names.add(name)
        p = Polygon(spec["outer"], spec.get("holes", []))
        if not p.is_valid or p.is_empty or p.area <= 1e-12:
            raise ValueError(f"{name}: invalid polygon: {shapely.is_valid_reason(p)}")
        if "height" in spec:
            raise ValueError(f"{name}: use 'depth' for extrusion; the polygon itself defines side-view height.")
        for key, value in [
            ("depth", 0.8), ("seed", 1),
            ("camera_yaw", 0), ("camera_pitch", 0), ("detail", 1),
            ("moss", 0.28), ("fit_mode", "playable_perimeter"),
            ("dirt_color", [0.55, 0.40, 0.27]), ("moss_color", [0.32, 0.46, 0.17]),
        ]:
            spec.setdefault(key, value)
        # Same recipe as the editor's boulderSlabCount/tolerance formula in
        # rope/src/server/boulderGenerator.ts: min(0.04, sqrt(area)*0.04).
        spec.setdefault("tolerance", min(0.04, math.sqrt(p.area) * 0.04))
        if spec["depth"] <= 0 or spec["tolerance"] <= 0:
            raise ValueError(f"{name}: depth and tolerance must be positive for the volumetric generator.")
        if not 0.25 <= float(spec["detail"]) <= 4:
            raise ValueError(f"{name}: detail must be between 0.25 and 4.")
        if not 0 <= float(spec["moss"]) <= 1:
            raise ValueError(f"{name}: moss must be between 0 and 1 (fraction of visible surface covered).")
        if spec["tolerance"] > math.sqrt(p.area) * 0.1:
            raise ValueError(f"{name}: tolerance is too large relative to the side silhouette.")
        spec["outer"] = list(orient(p, sign=1).exterior.coords)[:-1]
        spec["holes"] = [list(r.coords)[:-1] for r in orient(p, sign=1).interiors]
        specs.append(spec)
    if not specs:
        raise ValueError("Input must contain at least one dirt block.")
    return specs


def make_dirt_block(spec):
    from dirt_sdf import build_sdf_block
    return build_sdf_block(spec)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", default=str(ROOT / "polygons.json"))
    parser.add_argument("--output", default=str(ROOT / "regenerated"))
    parser.add_argument("--blender")
    parser.add_argument("--only", help="Generate the named input blocks (comma-separated)")
    parser.add_argument("--geometry-only", action="store_true", help="Write intermediate mesh JSON without Blender")
    parser.add_argument("--no-render", action="store_true")
    parser.add_argument("--preview-only", action="store_true", help="Skip texture baking and model exports for quick visual checks")
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--render-only", help="Render one named example while building and checking all of them")
    args = parser.parse_args()
    specs = read_specs(args.input)
    if args.only:
        specs = [s for s in specs if s["name"] in args.only.split(",")]
        if not specs:
            parser.error(f"No block named {args.only}")
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    blocks = []
    for spec in specs:
        print(f"Building {spec['name']}...", flush=True)
        blocks.append(make_dirt_block(spec))
    source = out / "source_geometry.json"
    source.write_text(json.dumps({"blocks": blocks}, separators=(",", ":")), encoding="utf-8")
    if not args.geometry_only:
        command = [str(find_blender(args.blender)), "--background", "--factory-startup", "--python-exit-code", "1",
                   "--python", str(ROOT / "dirt_build.py"), "--", str(source), "--samples", str(args.samples)]
        if args.no_render:
            command.append("--no-render")
        if args.preview_only:
            command.append("--preview-only")
        if args.render_only:
            command.extend(["--render-only", args.render_only])
        subprocess.run(command, check=True)
        # The boulder v5 validators are generic over the evaluated-mesh JSON
        # format (spec/health/vertices/triangles); dirt_build.py writes that
        # same shape, so they are reused unmodified rather than copied.
        subprocess.run([sys.executable, str(BOULDER_ROOT / "validate.py"), str(out)], check=True)
        if specs[0].get("fit_mode") == "playable_perimeter":
            subprocess.run([sys.executable, str(BOULDER_ROOT / "validate_centre.py"), str(out)], check=True)
    print(f"Completed: {out}", flush=True)


if __name__ == "__main__":
    main()
