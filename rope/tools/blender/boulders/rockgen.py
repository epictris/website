"""Polygon-constrained rock generation. Runs in ordinary Python, then calls Blender.

All geometry dimensions and tolerances use the input coordinate units.
No downloaded assets, external textures, or Blender add-ons are required.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / ".deps"))
import numpy as np
import shapely
from shapely import Polygon, Point, MultiPoint, LineString
from shapely.geometry.polygon import orient


def polygons(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == "Polygon":
        return [geometry]
    return [p for child in getattr(geometry, "geoms", []) for p in polygons(child)]


# Schema keys the generator already read under another name. Every other schema
# key travels in the spec under its own name and is read with params.param.
LEGACY_NAMES = {"seed": "seed", "depth": "depth", "tolerance": "tolerance",
                "edgeVariation": "edge_variation", "weathering": "weathering",
                "fractureAngle": "fracture_angle", "secondarySlabs": "secondary_slabs",
                "detail": "detail", "color": "color"}

# The recipe the level editor always runs. The editor never varied these, so they
# are not parameters: the frame must stay head-on for the game (yaw, pitch in
# degrees), `strata` only feeds the dead add_surface_relief, and the flags pick
# the hybrid, broad, game low-poly construction the approved rocks came from.
EDITOR_RECIPE = {"camera_yaw": 0, "camera_pitch": 0, "strata": 0.08,
                 "fit_mode": "playable_perimeter", "chunked_sides": True, "hybrid_faces": True,
                 "balanced_hybrid": True, "broad_side_chunks": True, "soften_thin_edges": True,
                 "solid_chunk_edges": True, "join_undercuts": False, "game_low_poly": True}

# Slab count bounds: tiny outlines stay rocky, large ones stay practical for the
# Boolean/remesh pass in Blender (slabs, dimensionless).
MIN_SLABS, MAX_SLABS = 2, 100


def outline_area(outline):
    """Shoelace area (m^2), summed in the order and grouping the fork's server
    used in JavaScript, so the tolerance derived from it is the same to the bit."""
    total = 0.0
    for i, point in enumerate(outline):
        after = outline[(i + 1) % len(outline)]
        total = total + point[0] * after[1] - after[0] * point[1]
    return abs(total / 2)


def js_round(x):
    """JavaScript's Math.round (halves go up), which the fork's slab count used."""
    whole = math.floor(x)
    return whole + 1 if x - whole >= 0.5 else whole


def slab_count(area, per_area):
    return max(MIN_SLABS, min(MAX_SLABS, js_round(area * per_area)))


def request_document(request):
    """The editor's request -> the rock document the fork's server wrote for it.

    A request is {"kind": "boulder", "outline": [[x, y], ...], "params": {...}},
    the outline in the object's local metres with y up and params holding only
    the values that differ from params.json. The document keeps the fork's field
    names and derived values (slab count, auto tolerance) so the construction
    code is unchanged; the other schema knobs ride along under their own names.
    """
    from params import defaults as schema_defaults
    overrides = request.get("params") or {}
    values = schema_defaults()
    unknown = sorted(set(overrides) - set(values))
    if unknown:
        raise ValueError(f"Unknown boulder parameters: {', '.join(unknown)}")
    values.update(overrides)
    outline = request["outline"]
    area = outline_area(outline)
    tolerance = values["tolerance"]
    if tolerance is None:
        # Blank: 4 % of the outline's linear size, capped at 4 cm (m).
        tolerance = min(0.04, math.sqrt(area) * 0.04)
    fork = {
        "depth": values["depth"], "seed": values["seed"],
        "slabs": slab_count(area, values["slabsPerArea"]), "tolerance": tolerance,
        "fracture_angle": values["fractureAngle"],
        "camera_yaw": EDITOR_RECIPE["camera_yaw"], "camera_pitch": EDITOR_RECIPE["camera_pitch"],
        "detail": values["detail"], "color": values["color"],
        "weathering": values["weathering"], "strata": EDITOR_RECIPE["strata"],
        "secondary_slabs": values["secondarySlabs"], "edge_variation": values["edgeVariation"],
    }
    fork.update((k, v) for k, v in EDITOR_RECIPE.items() if k not in fork)
    knobs = {k: v for k, v in values.items() if k not in LEGACY_NAMES}
    return {"plane": "CAMERA", "units": "metres", "defaults": dict(fork, **knobs),
            "rocks": [{"name": "boulder", "outer": outline}]}


def read_specs(path):
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if "outline" in data:
        data = request_document(data)
    if data.get("plane", "CAMERA") != "CAMERA":
        raise ValueError("This generator expects side-view polygons in the CAMERA plane, as [horizontal, vertical] pairs.")
    defaults = data.get("defaults", {})
    specs = []
    names = set()
    for index, entry in enumerate(data["rocks"]):
        spec = dict(defaults, **entry)
        name = spec.setdefault("name", f"rock_{index + 1:02d}")
        if not name or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in name):
            raise ValueError("Rock names must contain only letters, digits, underscores, or hyphens.")
        if name in names:
            raise ValueError(f"Duplicate rock name: {name}")
        names.add(name)
        p = Polygon(spec["outer"], spec.get("holes", []))
        if not p.is_valid or p.is_empty or p.area <= 1e-12:
            raise ValueError(f"{name}: invalid polygon: {shapely.is_valid_reason(p)}")
        if "height" in spec:
            raise ValueError(f"{name}: use 'depth' for extrusion; the polygon itself defines side-view height.")
        for key, value in [("depth", 0.8), ("seed", 1), ("slabs", 24), ("tolerance", 0.02),
                           ("fracture_angle", 0), ("camera_yaw",25), ("camera_pitch",12), ("detail", 1),
                           ("weathering", .8), ("strata", .45), ("secondary_slabs", .18), ("edge_variation",1),
                           ("color", [0.24, 0.25, 0.27])]:
            spec.setdefault(key, value)
        if spec["depth"] <= 0 or spec["tolerance"] <= 0:
            raise ValueError(f"{name}: depth and tolerance must be positive for the volumetric generator.")
        if not 1 <= int(spec["slabs"]) <= 250:
            raise ValueError(f"{name}: slabs must be between 1 and 250.")
        if not 0.25 <= float(spec["detail"]) <= 4:
            raise ValueError(f"{name}: detail must be between 0.25 and 4.")
        for key in ["weathering", "strata", "secondary_slabs", "edge_variation"]:
            if not 0 <= float(spec[key]) <= 1:
                raise ValueError(f"{name}: {key} must be between 0 and 1.")
        if spec["tolerance"] > math.sqrt(p.area) * 0.1:
            raise ValueError(f"{name}: tolerance is too large relative to the side silhouette.")
        spec["outer"] = list(orient(p, sign=1).exterior.coords)[:-1]
        spec["holes"] = [list(r.coords)[:-1] for r in orient(p, sign=1).interiors]
        specs.append(spec)
    if not specs:
        raise ValueError("Input must contain at least one rock.")
    return specs


class Mesh:
    def __init__(self, name, material=0):
        self.name, self.material = name, material
        self.vertices, self.faces = [], []
        self.lookup = {}

    def vertex(self, p):
        key = tuple(round(float(x), 9) for x in p)
        if key not in self.lookup:
            self.lookup[key] = len(self.vertices)
            self.vertices.append(list(key))
        return self.lookup[key]

    def face(self, points):
        indices = [self.vertex(p) for p in points]
        if len(set(indices)) >= 3:
            self.faces.append(indices)

    def dump(self):
        return dict(name=self.name, material=self.material, vertices=self.vertices, faces=self.faces)


def triangulate_cap(mesh, p, height, reverse=False):
    for triangle in shapely.constrained_delaunay_triangles(p).geoms:
        xy = list(orient(triangle, sign=1).exterior.coords)[:-1]
        points = [(x, y, height(x, y)) for x, y in xy]
        mesh.face(points[::-1] if reverse else points)


def prism(p, z0, z1, name, material=0):
    mesh = Mesh(name, material)
    triangulate_cap(mesh, p, lambda x, y: z0, reverse=True)
    triangulate_cap(mesh, p, lambda x, y: z1)
    for ring in [p.exterior, *p.interiors]:
        coords = list(ring.coords)
        for a, b in zip(coords[:-1], coords[1:]):
            mesh.face([(*a, z0), (*b, z0), (*b, z1), (*a, z1)])
    return mesh.dump()


def fracture_cells(p, count, rng, angle, elongation):
    """Anisotropic 2D Voronoi partition clipped exactly to a possibly holed polygon."""
    theta = math.radians(angle)
    c, s = math.cos(theta), math.sin(theta)
    matrix = np.array([[c, s], [-s / elongation, c / elongation]])
    inverse = np.linalg.inv(matrix)
    transformed = shapely.transform(p, lambda xy: xy @ matrix.T)
    minx, miny, maxx, maxy = transformed.bounds
    seeds = []
    min_dist = math.sqrt(transformed.area / count) * 0.34
    for attempt in range(count * 1000):
        xy = rng.uniform([minx, miny], [maxx, maxy])
        if transformed.contains(Point(xy)) and (not seeds or min(np.linalg.norm(xy - q) for q in seeds) > min_dist):
            seeds.append(xy)
        if len(seeds) == count:
            break
    if len(seeds) != count:
        raise ValueError("Unable to sample fracture seeds; reduce the slab count.")
    if count == 1:
        return [p]
    diagram = shapely.voronoi_polygons(MultiPoint(seeds), extend_to=transformed.envelope)
    cells = []
    for cell in diagram.geoms:
        for clipped in polygons(cell.intersection(transformed)):
            if clipped.area > p.area * 1e-8:
                cells.append(orient(shapely.transform(clipped, lambda xy: xy @ inverse.T), sign=1))
    return sorted(cells, key=lambda q: (round(q.centroid.x, 8), round(q.centroid.y, 8)))


def erode_cell(cell, p, epsilon, rng):
    if epsilon == 0:
        return [cell]
    # Erosion is bounded before any surface decoration. Acute tips are restored
    # by the outer supporting volume and independently measured after export.
    inset = min(epsilon * rng.uniform(0.14, 0.24), math.sqrt(cell.area) * 0.025)
    for _ in range(12):
        inset_geometry = cell.buffer(-inset, join_style="mitre", mitre_limit=2)
        parts = polygons(inset_geometry)
        if (parts and sum(q.area for q in parts) > cell.area * 0.7
                and cell.hausdorff_distance(inset_geometry) <= epsilon * 0.3):
            return [orient(q, sign=1) for q in parts]
        inset *= 0.5
    return [cell]


def slab_mesh(q, p, height, z0, rng, name, detail, epsilon, material):
    """Faceted loft. Convex footprints allow inward chips with a containment proof.

    Nonconvex/holed pieces retain XY coordinates; their caps use constrained
    triangulation. This avoids centroid scaling across a concavity.
    """
    mesh = Mesh(name, material)
    convex = not q.interiors and abs(q.convex_hull.area - q.area) < q.area * 1e-8
    centre = np.array([q.centroid.x, q.centroid.y])
    scale = math.sqrt(q.area)
    slope = rng.uniform(-0.23, 0.23, 2) * min(1, height / max(scale * 2, 1e-9))
    phase = rng.uniform(0, 6.28, 2)

    def top_z(x, y):
        return height + np.dot(np.array([x, y]) - centre, slope) + min(scale, height) * 0.045 * (
            math.sin(x * 5 + phase[0]) * math.cos(y * 4 + phase[1]))

    # A few long faces give geological structure; small shading features are
    # supplied by the material rather than making every face equally noisy.
    levels = [0.0, 0.04, 0.26, 0.49, 0.71, 0.94, 1.0]
    original_rings = []
    all_levels = []
    for ring in [q.exterior, *q.interiors]:
        coords = list(ring.coords)
        sampled = []
        for a, b in zip(coords[:-1], coords[1:]):
            length = np.linalg.norm(np.array(b) - a)
            steps = max(1, math.ceil(length / (0.22 / detail)))
            for j in range(steps):
                sampled.append(np.array(a) * (1 - j / steps) + np.array(b) * j / steps)
        original_rings.append(sampled)
        ring_levels = []
        corner_noise = rng.uniform(0.1, 1, len(sampled))
        for level_index, t in enumerate(levels):
            result = []
            for index, xy in enumerate(sampled):
                shifted = xy.copy()
                if convex:
                    direction = centre - xy
                    distance = np.linalg.norm(direction)
                    if distance > 1e-12:
                        budget = min(scale * 0.24, distance * 0.26)
                        # A visible shoulder preserves the original cell exactly.
                        # The remaining bands can erode much farther inward: this
                        # gives deep side relief without changing its projection.
                        band = [0.08, 0.3, 0.85, 0.24, 0.0, 0.52, 0.94][level_index]
                        # Same boundary sample / different bands = chipped slabs.
                        amount = budget * band * corner_noise[index]
                        shifted += direction / distance * amount
                z = z0 + t * (top_z(*shifted) - z0)
                if 0 < t < 1:
                    z += height * 0.012 * math.sin(index * 1.3 + phase[0])
                result.append((*shifted, z))
            ring_levels.append(result)
        all_levels.append(ring_levels)
        for low, high in zip(ring_levels[:-1], ring_levels[1:]):
            for i in range(len(sampled)):
                j = (i + 1) % len(sampled)
                # Triangles avoid nonplanar quads producing unpredictable export.
                mesh.face([low[i], low[j], high[j]])
                mesh.face([low[i], high[j], high[i]])

    for level_index, reverse in [(0, True), (-1, False)]:
        rings = [[(v[0], v[1]) for v in ls[level_index]] for ls in all_levels]
        cap = Polygon(rings[0], rings[1:])
        if not cap.is_valid:
            raise ValueError(f"Invalid loft cap for {name}: {shapely.is_valid_reason(cap)}")
        triangulate_cap(mesh, cap, (lambda x, y: z0) if reverse else top_z, reverse=reverse)
    return mesh.dump()


def make_relief_panel(spec):
    p = orient(Polygon(spec["outer"], spec.get("holes", [])), sign=1)
    rng = np.random.default_rng(int(spec["seed"]))
    h, eps = float(spec["depth"]), float(spec["tolerance"])
    cells = fracture_cells(p, int(spec["slabs"]), rng, spec["fracture_angle"], spec["elongation"])
    # Build in (screen-x, screen-up, depth), then rotate into world XZ in
    # Blender. This is a rear rock mass, never a ground footprint or pedestal.
    core = prism(p, 0, h * 0.42, "rear_mass", 0)
    meshes = [core]
    for index, cell in enumerate(cells):
        erosion_budget = eps if eps > 0 else math.sqrt(p.area) * 2e-6
        for part_index, q in enumerate(erode_cell(cell, p, erosion_budget, rng)):
            ztop = h * rng.uniform(0.77, 1.16)
            meshes.append(slab_mesh(q, p, ztop, h * 0.06, rng,
                                    f"slab_{index:03d}_{part_index}", spec["detail"], eps,
                                    int(rng.integers(0, 5))))
    return {"spec": spec, "parts": meshes, "cell_count": len(cells)}


def make_rock(spec):
    if spec.get('hybrid_faces'):
        from hybrid_geometry import build_hybrid
        return build_hybrid(spec)
    if spec.get('chunked_sides'):
        from chunk_geometry import build_chunks
        return build_chunks(spec)
    if spec.get('fit_mode') in ['centre_plane','playable_perimeter']:
        from centre_geometry import build_centre
        return build_centre(spec)
    from volume_geometry import build_volume
    return build_volume(spec)


def find_blender(override=None):
    if override:
        path = Path(override)
    elif os.environ.get("BLENDER_PATH"):
        path = Path(os.environ["BLENDER_PATH"])
    elif shutil.which("blender"):
        path = Path(shutil.which("blender"))
    else:
        candidates = sorted(Path("C:/Program Files/Blender Foundation").glob("Blender */blender.exe"))
        if not candidates:
            raise FileNotFoundError("Blender not found. Supply --blender or set BLENDER_PATH.")
        path = candidates[-1]
    if not path.is_file():
        raise FileNotFoundError(path)
    return path


def main(engine="python"):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", default=str(ROOT / "polygons.json"))
    parser.add_argument("--output", default=str(ROOT / "assets"))
    parser.add_argument("--blender")
    parser.add_argument("--only", help="Generate one named input rock")
    parser.add_argument("--geometry-only", action="store_true", help="Write intermediate mesh JSON without Blender")
    parser.add_argument("--no-render", action="store_true")
    parser.add_argument('--preview-only',action='store_true',help='Skip texture baking and model exports for quick visual checks')
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--render-only", help="Render one named example while building and checking all of them")
    args = parser.parse_args()
    specs = read_specs(args.input)
    if args.only:
        specs = [s for s in specs if s["name"] == args.only]
        if not specs:
            parser.error(f"No rock named {args.only}")
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    rocks = []
    for spec in specs:
        if engine=="nodes":
            spec=dict(spec,name=spec["name"]+"_nodes",engine="nodes")
        print(f"Building {spec['name']}...", flush=True)
        rocks.append(make_rock(spec))
    source = out / "source_geometry.json"
    source.write_text(json.dumps({"rocks": rocks}, separators=(",", ":")), encoding="utf-8")
    if not args.geometry_only:
        command = [str(find_blender(args.blender)), "--background", "--factory-startup", "--python-exit-code", "1", "--python",
                   str(ROOT / "blender_build.py"), "--", str(source), "--samples", str(args.samples)]
        if args.no_render:
            command.append("--no-render")
        if args.preview_only:
            command.append('--preview-only')
        if args.render_only:
            command.extend(["--render-only",args.render_only+("_nodes" if engine=="nodes" else "")])
        subprocess.run(command, check=True)
        validator='validate_centre.py' if specs[0].get('fit_mode')=='centre_plane' else 'validate.py'
        subprocess.run([sys.executable, str(ROOT / validator), str(out)], check=True)
        if specs[0].get('fit_mode')=='playable_perimeter':
            subprocess.run([sys.executable, str(ROOT / 'validate_centre.py'), str(out)], check=True)
    print(f"Completed: {out}", flush=True)


if __name__ == "__main__":
    main()
