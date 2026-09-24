"""Independently inspect the triangulated, Boolean-unioned output from Blender."""
from __future__ import annotations

import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / ".deps"))
import numpy as np
import shapely
from shapely import Polygon, LineString, Point
from PIL import Image, ImageDraw, ImageFont


def clip_above(triangle, threshold):
    result = []
    for i, start in enumerate(triangle):
        end = triangle[(i + 1) % len(triangle)]
        inside_start, inside_end = start[2] >= threshold, end[2] >= threshold
        if inside_start:
            result.append(start)
        if inside_start != inside_end:
            t = (threshold - start[2]) / (end[2] - start[2])
            result.append(start + t * (end - start))
    return result


def projected_union(vertices, faces, threshold=None, grid=1e-7):
    pieces = []
    for face in faces:
        points = vertices[face]
        if threshold is not None:
            points = clip_above(points, threshold)
        if len(points) >= 3:
            poly = Polygon([(v[0], v[1]) for v in points])
            if poly.is_valid and poly.area > grid * grid:
                pieces.append(poly)
    if not pieces:
        return Polygon()
    joined = shapely.union_all(pieces, grid_size=grid)
    # Overlay arithmetic can leave zero-width, near-zero-area interior rings
    # along coincident triangle edges. They are not physical holes. Discard only
    # rings below the precision-grid width threshold, not ordinary small gaps.
    def clean(geometry):
        if geometry.geom_type == "Polygon":
            return Polygon(geometry.exterior, [r for r in geometry.interiors
                                               if not Polygon(r).buffer(-grid*10).is_empty])
        if hasattr(geometry, "geoms"):
            return shapely.union_all([clean(g) for g in geometry.geoms])
        return geometry
    return clean(joined)


def coords_on_boundary(p, step):
    points = []
    for ring in [p.exterior, *p.interiors]:
        coords = list(ring.coords)
        for a, b in zip(coords[:-1], coords[1:]):
            a, b = np.array(a), np.array(b)
            count = max(1, math.ceil(np.linalg.norm(b - a) / step))
            points.extend(a + (b - a) * t / count for t in range(count))
    return np.array(points)


def validate_mesh(data):
    spec, health = data["spec"], data["health"]
    p = Polygon(spec["outer"], spec.get("holes", []))
    world_vertices = np.array(data["vertices"])
    # Project the designated side view: world XZ, looking from negative Y.
    if "camera_basis" in spec:
        vertices = world_vertices @ np.array(spec["camera_basis"])
    else:
        vertices = world_vertices[:, [0, 2, 1]].copy()
        vertices[:, 2] *= -1
    faces = np.array(data["triangles"], dtype=int)
    diagonal = math.hypot(p.bounds[2] - p.bounds[0], p.bounds[3] - p.bounds[1])
    numeric = max(1e-6, diagonal * 2e-6)
    eps = spec["tolerance"]
    if spec.get("construction") == "volume":
        # Front-facing triangles project all actually visible surface positions.
        # The old panel's fixed depth threshold does not describe a 3D body.
        triangles = vertices[faces]
        normals = np.cross(triangles[:,1]-triangles[:,0], triangles[:,2]-triangles[:,0])
        upper = projected_union(vertices, faces[normals[:,2] > 1e-12])
        silhouette = upper
    else:
        silhouette = projected_union(vertices, faces)
        upper = projected_union(vertices, faces, spec["depth"] * 0.51)
    step = max(eps / 10, diagonal / 5000)
    samples = coords_on_boundary(p, step)
    sample_points = shapely.points(samples)
    front_distances = shapely.distance(sample_points, upper)
    # Full boundary Hausdorff includes holes, unlike a convex hull or AABB test.
    error = float(shapely.hausdorff_distance(p.boundary, silhouette.boundary, densify=0.05))
    front_max = float(np.max(front_distances))
    front_bound = front_max + step / 2
    front_covered = upper.buffer(eps + numeric, quad_segs=16).covers(p.boundary)
    outside = silhouette.difference(p).area
    missing = p.difference(silhouette).area
    holes = sum(Polygon(ring).intersection(silhouette).area for ring in p.interiors)
    forbidden_outside = silhouette.difference(p.buffer(eps + numeric)).area
    protected_hole_fill = sum(Polygon(ring).buffer(-eps - numeric).intersection(silhouette).area
                              for ring in p.interiors)
    # Local topology and positive volume checked independently from projection.
    valid_mesh = (health["nonmanifold_edges"] == 0 and health["boundary_edges"] == 0
                  and health["connected_components"] == 1 and health["volume"] > 0)
    edge_error_ok = error <= eps + numeric
    pass_all = bool(valid_mesh and edge_error_ok and front_covered
                    and forbidden_outside <= p.area * 1e-9 and protected_hole_fill <= p.area * 1e-9)
    result = {
        "name": spec["name"], "seed": spec["seed"], "tolerance": eps,
        "outline_error": error,
        "front_boundary_sample_max": front_max,
        "front_boundary_conservative_bound": front_bound,
        "front_boundary_within_tolerance": bool(front_covered),
        "front_measurement_depth": None if spec.get("construction") == "volume" else spec["depth"] * 0.51,
        "projection_plane": "fixed camera" if "camera_basis" in spec else "XZ",
        "camera_basis": spec.get("camera_basis"),
        "construction": spec.get("construction", "relief"),
        "outside_area": outside, "missing_area": missing,
        "outside_percent": 100 * outside / p.area,
        "missing_percent": 100 * missing / p.area,
        "filled_hole_area": holes,
        "outside_tolerance_band_area": forbidden_outside,
        "protected_hole_fill_area": protected_hole_fill,
        "numeric_allowance": numeric,
        "passed": pass_all, **health,
    }
    return result, p, silhouette, upper


def load_font(size, bold=False):
    name = "segoeuib.ttf" if bold else "segoeui.ttf"
    path = Path("C:/Windows/Fonts") / name
    try:
        return ImageFont.truetype(str(path), size)
    except OSError:
        return ImageFont.load_default()


def render_outline(p, actual, upper, result, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.path import Path as MplPath
    from matplotlib.patches import PathPatch

    def draw_polygon(ax, geometry, face, edge, alpha, width=1):
        if geometry.is_empty:
            return
        if geometry.geom_type != "Polygon":
            for g in getattr(geometry, "geoms", []):
                draw_polygon(ax, g, face, edge, alpha, width)
            return
        for_poly = shapely.geometry.polygon.orient(geometry, sign=1)
        verts, codes = [], []
        for ring in [for_poly.exterior, *for_poly.interiors]:
            xy = list(ring.coords)
            verts.extend(xy)
            codes.extend([MplPath.MOVETO] + [MplPath.LINETO] * (len(xy)-2) + [MplPath.CLOSEPOLY])
        ax.add_patch(PathPatch(MplPath(verts, codes), facecolor=face, edgecolor=edge,
                               alpha=alpha, linewidth=width))

    fig, axes = plt.subplots(1, 2, figsize=(10, 5), facecolor="#f4f2ed", layout="constrained")
    for ax in axes:
        ax.set_facecolor("#f4f2ed")
        ax.set_aspect("equal")
        pad = max(p.bounds[2]-p.bounds[0], p.bounds[3]-p.bounds[1]) * 0.12
        ax.set_xlim(p.bounds[0]-pad, p.bounds[2]+pad)
        ax.set_ylim(p.bounds[1]-pad, p.bounds[3]+pad)
        ax.spines[["top", "right"]].set_visible(False)
        ax.set_xlabel("camera horizontal / metres")
        ax.set_ylabel("camera vertical / metres")
    draw_polygon(axes[0], actual, "#647977", "none", 0.85)
    draw_polygon(axes[1], upper, "#647977", "none", 0.85)
    for ax in axes:
        draw_polygon(ax, p, "none", "#c65333", 1, 1.6)
    axes[0].set_title(f"Whole rock · error {result['outline_error'] * 1000:.3f} mm", loc="left")
    axes[1].set_title("Visible surface coverage" if result.get("construction") == "volume" else "Front relief coverage", loc="left")
    fig.suptitle(result["name"].replace("_", " ") + "  /  input outline in rust", fontsize=15, ha="left", x=0.04)
    fig.savefig(path, dpi=150)
    plt.close(fig)


def contact_sheet(out, results):
    available = [(r, out / "renders" / (r["name"] + ".png")) for r in results]
    available = [(r, p) for r, p in available if p.exists()]
    if not available:
        return
    cols = min(3, len(available))
    rows = math.ceil(len(available) / cols)
    cellw, cellh, header = 580, 650, 128
    sheet = Image.new("RGB", (cols*cellw, rows*cellh+header), "#f0eee8")
    draw = ImageDraw.Draw(sheet)
    central='centre_section_error' in results[0]
    draw.text((32, 24), "CENTRE PLANE / STONE" if central else "POLYGON / STONE", fill="#252928", font=load_font(35, True))
    subtitle='Fixed gameplay slice / free front and back forms' if central else 'Procedural geometry / side-view silhouettes'
    draw.text((34, 75), subtitle, fill="#5a625f", font=load_font(21))
    for i, (result, path) in enumerate(available):
        x, y = (i % cols)*cellw, header+(i//cols)*cellh
        image = Image.open(path).convert("RGB").resize((cellw, 550), Image.Resampling.LANCZOS)
        sheet.paste(image, (x, y))
        label = result["name"][3:].replace("_", " ").upper()
        draw.text((x+22,y+566), label, font=load_font(24,True), fill="#252928")
        draw.text((x+22,y+602), f"{result['faces']:,} triangles  /  {'PASS' if result['passed'] else 'FAIL'}  /  seed {result['seed']}",
                  font=load_font(19), fill="#5a625f")
    sheet.save(out / "contact_sheet.png")


def side_comparison(out, result):
    """Match input coordinates to the orthographic render's actual camera scale."""
    side_path = out / "renders" / (result["name"] + "_side.png")
    angled_path = out / "renders" / (result["name"] + ".png")
    if not side_path.exists() or not angled_path.exists():
        return
    data = json.loads((out / "evaluated" / (result["name"] + ".json")).read_text())
    vertices = np.array(data["vertices"])
    if "camera_basis" in data["spec"]:
        projected = vertices @ np.array(data["spec"]["camera_basis"])
        xmin, xmax = projected[:,0].min(), projected[:,0].max()
        zmin, zmax = projected[:,1].min(), projected[:,1].max()
    else:
        xmin, xmax = vertices[:, 0].min(), vertices[:, 0].max()
        zmin, zmax = vertices[:, 2].min(), vertices[:, 2].max()
    cx, cz = (xmin + xmax)/2, (zmin + zmax)/2
    camera_scale = max(xmax-xmin, zmax-zmin) * 1.16
    width, height, top = 560, 560, 124
    canvas = Image.new("RGB", (width*3, height+top+50), "#f0eee8")
    draw = ImageDraw.Draw(canvas)
    draw.text((26, 18), "SIDE SILHOUETTE / 3D ROCK", font=load_font(30, True), fill="#272d2a")
    draw.text((26, 64), "The polygon controls the visible outline. Depth is generated behind it.", font=load_font(21), fill="#606762")
    for i, label in enumerate(["01  INPUT POLYGON", "02  ORTHOGRAPHIC FIT", "03  GENERATED VOLUME"]):
        draw.text((i*width+24, 99), label, font=load_font(17,True), fill="#272d2a")
    canvas.paste(Image.open(side_path).convert("RGB").resize((width,height), Image.Resampling.LANCZOS), (width,top))
    canvas.paste(Image.open(angled_path).convert("RGB").resize((width,height), Image.Resampling.LANCZOS), (width*2,top))
    def screen(point, panel):
        return ((point[0]-cx)/camera_scale*width+width/2+panel*width,
                top+height/2-(point[1]-cz)/camera_scale*height)
    for panel in [0,1]:
        for i, ring in enumerate([data["spec"]["outer"], *data["spec"]["holes"]]):
            coords = [screen(p,panel) for p in ring]
            if panel == 0:
                draw.polygon(coords, fill="#6b7974" if i==0 else "#f0eee8")
            draw.line(coords+[coords[0]], fill="#e69c5b" if panel else "#3d4c45", width=2, joint="curve")
    draw.text((26,top+height+14), f"Measured outline error: {result['outline_error']*1000:.2f} mm   /   allowance: {result['tolerance']*1000:.0f} mm   /   connected, watertight mesh", font=load_font(20), fill="#3d4c45")
    canvas.save(out / "side_fit.png")


def main():
    out = Path(sys.argv[1]).resolve()
    report_dir = out / "validation"
    report_dir.mkdir(exist_ok=True)
    results = []
    for path in sorted((out / "evaluated").glob("*.json")):
        result, p, silhouette, upper = validate_mesh(json.loads(path.read_text(encoding="utf-8")))
        results.append(result)
        render_outline(p, silhouette, upper, result, report_dir / (result["name"] + ".png"))
        print(f"{result['name']}: {'PASS' if result['passed'] else 'FAIL'}; outline {result['outline_error']:.8f}; front edge {result['front_boundary_sample_max']:.6f}; nonmanifold {result['nonmanifold_edges']}", flush=True)
    if not results:
        raise SystemExit("No evaluated meshes found.")
    (out / "validation.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    lines = ["# Polygon rock validation", "", "Measurements project the final triangulated Blender meshes into the specified orthographic camera plane, before scene-layout translations. Input units are metres for the included examples.", "",
             "| Rock | Result | Side outline error (mm) | Front edge gap (mm) | Tolerance (mm) | Triangles | Components |", "|---|---|---:|---:|---:|---:|---:|"]
    for r in results:
        lines.append(f"| {r['name']} | {'PASS' if r['passed'] else 'FAIL'} | {r['outline_error']*1000:.4f} | {r['front_boundary_sample_max']*1000:.2f} | {r['tolerance']*1000:.1f} | {r['faces']} | {r['connected_components']} |")
    lines += ["", "Outline error is the symmetric Hausdorff distance of the projected mesh boundary, including holes. Front edge gap samples distance from the input boundary to the projected camera-facing surface. A separate buffered-coverage test checks the complete input boundary against tolerance.", "",
              "Checks also include outside area, hole fill, boundary edges, nonmanifold edges, connected components, and positive volume. This is not an exhaustive triangle-triangle self-intersection test. Small numeric allowance accommodates Blender single-precision coordinates; see validation.json.", "",
              "Overlapping 3D slabs join a shaped inner solid. Voxel consolidation, smoothing, simplification and bevels are included in these measurements; shader bump and exported normal maps do not move geometry. Polygon-overlay holes narrower than approximately two millionths of an input unit are excluded as numerical slivers."]
    (out / "VALIDATION.md").write_text("\n".join(lines)+"\n", encoding="utf-8")
    contact_sheet(out, results)
    side_comparison(out, results[0])
    if not all(r["passed"] for r in results):
        raise SystemExit("Validation failed. Inspect output/validation.json.")


if __name__ == "__main__":
    main()
