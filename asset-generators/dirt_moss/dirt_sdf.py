"""Signed-distance construction of a soft dirt block with moss cushions.

The boulder v5 route (convex chunks -> boolean clip to a straight outline
prism -> union -> remesh) leaves every chunk that touches the outline with a
flat clipped wall, so a soft block reads as one extruded slab. Here the same
inputs (side-view outline, Lloyd-relaxed Voronoi chunk seeds) drive a distance
field instead:

- every chunk is a rounded, domed extrusion of its Voronoi cell, so it bulges
  toward the camera and rounds away over the top, the sides and the outline;
- chunks are separated by a gap, so a soft groove runs between neighbours;
- a thinner rounded core of the whole outline fills the groove floors and
  keeps the block one solid;
- at depth 0 both the chunks and the core end exactly on the outline, so the
  gameplay slice and the projected silhouette still match the polygon;
- moss is the dirt surface pushed out by a thickness field whose footprint is
  seeded low-frequency noise, thresholded by area-weighted quantile so it
  covers `moss` of the visible surface, evenly scattered with no facing bias.

The field is meshed with naive surface nets (no extra dependency).
"""
import math
import numpy as np
from scipy.spatial import cKDTree
import shapely
from shapely import Polygon
from shapely.geometry.polygon import orient

MOSS_FRONT_MIN = -0.25   # faces turned further from the camera are the unseen back
MOSS_UNDER_MIN = -0.70   # faces turned further down are the unseen underside


def signed_distance_2d(p, xy):
    d = shapely.distance(p.boundary, shapely.points(xy))
    inside = shapely.contains_xy(p, xy[:, 0], xy[:, 1])
    return np.where(inside, -d, d)


def cell_distance(xy, seeds, i):
    """Signed distance-like value to Voronoi cell i (negative inside)."""
    best = np.full(len(xy), -1e9)
    for j in range(len(seeds)):
        if j == i:
            continue
        n = seeds[j] - seeds[i]
        n = n / np.linalg.norm(n)
        best = np.maximum(best, (xy - (seeds[i] + seeds[j]) / 2) @ n)
    return best


def rounded_extrusion(d2, z, half, radius):
    w0 = d2 + radius
    w1 = np.abs(z) - half + radius
    return (np.minimum(np.maximum(w0, w1), 0)
            + np.sqrt(np.maximum(w0, 0) ** 2 + np.maximum(w1, 0) ** 2) - radius)


def smooth_min(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b + (a - b) * h - k * h * (1 - h)


def sine_noise(rng, wavelength, count=8, octave=0.35):
    """Seeded smooth 3D noise as a sum of random plane waves (two octaves)."""
    waves = []
    for scale, weight in [(1.0, 1.0), (1 / 2.2, octave)]:
        for _ in range(count):
            d = rng.normal(size=3)
            d /= np.linalg.norm(d)
            k = 2 * math.pi / (wavelength * scale * rng.uniform(0.8, 1.25))
            waves.append((d * k, rng.uniform(0, 2 * math.pi), weight))
    total = sum(w for _, _, w in waves)

    def value(points):
        out = np.zeros(points.shape[:-1])
        for k, phase, weight in waves:
            out += weight * np.sin(points @ k + phase)
        return out / total * math.sqrt(2 * count)
    return value


def surface_nets(F, origin, h):
    """Naive surface nets over a grid whose border is outside (F > 0)."""
    nx, ny, nz = F.shape
    corners = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 0), (0, 0, 1), (1, 0, 1), (0, 1, 1), (1, 1, 1)]
    edges = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)]
    values = [F[a:nx - 1 + a, b:ny - 1 + b, c:nz - 1 + c] for a, b, c in corners]
    acc = np.zeros((nx - 1, ny - 1, nz - 1, 3))
    cnt = np.zeros((nx - 1, ny - 1, nz - 1))
    for e0, e1 in edges:
        f0, f1 = values[e0], values[e1]
        crossing = (f0 < 0) != (f1 < 0)
        t = np.where(crossing, f0 / np.where(crossing, f0 - f1, 1), 0)
        p0, p1 = np.array(corners[e0], float), np.array(corners[e1], float)
        acc += np.where(crossing[..., None], p0 + t[..., None] * (p1 - p0), 0)
        cnt += crossing
    active = cnt > 0
    index = -np.ones(cnt.shape, dtype=np.int64)
    index[active] = np.arange(int(active.sum()))
    cells = np.argwhere(active)
    verts = origin + (cells + acc[active] / cnt[active][:, None]) * h
    inside = F < 0
    quads = []
    # Edge along x between (i,j,k) and (i+1,j,k): the four cells around it.
    m = inside[:-1, 1:-1, 1:-1] != inside[1:, 1:-1, 1:-1]
    i, j, k = np.nonzero(m); j += 1; k += 1
    q = np.stack([index[i, j - 1, k - 1], index[i, j, k - 1], index[i, j, k], index[i, j - 1, k]], 1)
    quads.append(np.where(inside[i, j, k][:, None], q, q[:, ::-1]))
    m = inside[1:-1, :-1, 1:-1] != inside[1:-1, 1:, 1:-1]
    i, j, k = np.nonzero(m); i += 1; k += 1
    q = np.stack([index[i - 1, j, k - 1], index[i - 1, j, k], index[i, j, k], index[i, j, k - 1]], 1)
    quads.append(np.where(inside[i, j, k][:, None], q, q[:, ::-1]))
    m = inside[1:-1, 1:-1, :-1] != inside[1:-1, 1:-1, 1:]
    i, j, k = np.nonzero(m); i += 1; j += 1
    q = np.stack([index[i - 1, j - 1, k], index[i, j - 1, k], index[i, j, k], index[i - 1, j, k]], 1)
    quads.append(np.where(inside[i, j, k][:, None], q, q[:, ::-1]))
    quads = np.concatenate(quads)
    assert (quads >= 0).all(), "surface nets referenced an inactive cell"
    return verts, quads


def face_stats(verts, quads):
    a, b, c, d = (verts[quads[:, n]] for n in range(4))
    normal = np.cross(c - a, d - b)
    area = np.linalg.norm(normal, axis=1) / 2
    normal = normal / np.maximum(area[:, None] * 2, 1e-12)
    return (a + b + c + d) / 4, normal, area


def visible(normal):
    return (normal[:, 2] > MOSS_FRONT_MIN) & (normal[:, 1] > MOSS_UNDER_MIN)


def build_sdf_block(spec):
    from rockgen import Mesh, triangulate_cap
    from volume_geometry import camera_basis
    from dirt_chunk_geometry import farthest_point_seeds, lloyd_relax

    p = orient(Polygon(spec["outer"], spec["holes"]), 1)
    rng = np.random.default_rng(int(spec["seed"]) + 4110)
    depth, tol = float(spec["depth"]), float(spec["tolerance"])
    half = depth * 0.5
    h = float(spec.get("voxel", 0.02))

    # Few, big chunks; a single relaxation pass keeps them from clustering
    # without making them a regular tiling.
    count = int(np.clip(round(p.area * 1.2), 2, 10))
    seeds = lloyd_relax(farthest_point_seeds(p, count, rng), p, 1, rng)

    moss_thick = float(spec.get("moss_thickness", 0.04))
    reach = half * 1.7 + moss_thick + 4 * h
    minx, miny, maxx, maxy = p.bounds
    pad = moss_thick + 4 * h
    xs = np.arange(minx - pad, maxx + pad + h, h)
    ys = np.arange(miny - pad, maxy + pad + h, h)
    zs = np.arange(-reach, reach + h, h)
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    xy = np.column_stack([gx.ravel(), gy.ravel()])
    shape2 = gx.shape
    d_out = signed_distance_2d(p, xy).reshape(shape2)
    z = zs[None, None, :]

    # Core: sits just under the chunk faces, so a join between two chunks is
    # a shallow soft dip rather than a crack; ends on the outline at depth 0.
    core_half = half * 0.80
    field = rounded_extrusion(d_out[..., None], z, core_half, core_half * 0.85)

    # Warp the Voronoi borders so chunk outlines wander instead of running
    # as straight bisectors.
    cell_size = math.sqrt(p.area / count)
    warp_rng = np.random.default_rng(int(spec["seed"]) + 1234)
    warp_x = sine_noise(warp_rng, cell_size * 0.9, 5, 0.4)
    warp_y = sine_noise(warp_rng, cell_size * 0.9, 5, 0.4)
    xyz = np.column_stack([xy, np.zeros(len(xy))])
    warped = xy + 0.16 * cell_size * np.column_stack([warp_x(xyz), warp_y(xyz)])

    gap = float(spec.get("groove", 0.012))
    blend = float(spec.get("blend", 0.14))
    chunks = None
    for i in range(count):
        c = np.maximum(d_out.ravel(), cell_distance(warped, seeds, i) + gap).reshape(shape2)
        cell_area = float((c < 0).sum()) * h * h
        if cell_area <= 0:
            continue
        inradius = 0.5 * math.sqrt(cell_area)
        base = half * rng.uniform(0.86, 1.08)
        dome = half * rng.uniform(0.15, 0.38) * np.sqrt(np.clip(-c / inradius, 0, 1))
        # An off-centre crown makes each chunk lean like a real clod.
        tilt = ((xy - seeds[i]) @ rng.uniform(-0.14, 0.14, 2)).reshape(shape2)
        chunk_half = base + dome + np.clip(tilt, -half * 0.2, half * 0.2)
        radius = min(base * 0.62, inradius * 0.60)
        sdf = rounded_extrusion(c[..., None], z, chunk_half[..., None], radius)
        chunks = sdf if chunks is None else smooth_min(chunks, sdf, blend)
    field = smooth_min(field, chunks, 0.08)

    gz = np.broadcast_to(zs[None, None, :], field.shape)
    points = np.stack([np.broadcast_to(gx[..., None], field.shape),
                       np.broadcast_to(gy[..., None], field.shape), gz], -1)
    lumps = sine_noise(np.random.default_rng(int(spec["seed"]) + 77), 0.7, 6, 0.4)
    field = field + 0.014 * lumps(points)

    def closed(F):
        F = F.copy()
        F[[0, -1], :, :] = F[:, [0, -1], :] = 1.0
        F[:, :, [0, -1]] = 1.0
        return F

    origin = np.array([xs[0], ys[0], zs[0]])
    # A surface-normal hint lets moss favour ledges and upward faces without
    # tying its placement to the fixed camera's front direction.
    gradient = np.gradient(field, h)
    upward_grid = gradient[1] / np.maximum(
        np.sqrt(sum(component * component for component in gradient)), 1e-8)
    del gradient
    verts, quads = surface_nets(closed(field), origin, h)

    # Moss footprint: seeded noise with no directional bias, thresholded by
    # area-weighted quantile over the visible dirt surface.
    target = float(spec["moss"])
    wavelength = float(np.clip(0.45 * math.sqrt(p.area), 0.8, 1.4))
    moss_noise = sine_noise(np.random.default_rng(int(spec["seed"]) + 991), wavelength)
    centre, normal, area = face_stats(verts, quads)
    seen = visible(normal)
    # Fluff without extra assets: the cushion is a pile of small rounded
    # clumps (Worley domes), and its edge is frayed by fine noise so it
    # breaks into tufts and stray islands instead of ending on a clean line.
    width = 0.04
    fray = sine_noise(np.random.default_rng(int(spec["seed"]) + 313), 0.11, 7, 0.5)
    clump_rng = np.random.default_rng(int(spec["seed"]) + 555)
    lo = np.array([xs[0], ys[0], zs[0]])
    hi = np.array([xs[-1], ys[-1], zs[-1]])
    spacing, radius = float(spec.get("clump_spacing", 0.075)), float(spec.get("clump_radius", 0.065))
    tree = cKDTree(clump_rng.uniform(lo, hi, (int(np.prod((hi - lo) / spacing)), 3)))

    def clumps(pts):
        d, _ = tree.query(pts.reshape(-1, 3), k=1, workers=-1)
        return np.sqrt(np.clip(1 - (d / radius) ** 2, 0, 1)).reshape(pts.shape[:-1])

    def edge(pts):
        s = np.clip((moss_noise(pts) + 0.28 * fray(pts) - threshold) / width, 0, 1)
        return s * s * (3 - 2 * s)

    def thickness(pts, d2, up, e=None):
        e = edge(pts) if e is None else e
        ledge = np.clip((up + 0.2) / 0.85, 0, 1)
        t = moss_thick * (0.27 + 1.05 * clumps(pts)) * e ** 0.45 * (0.32 + 0.68 * ledge ** 2)
        # Never let a cushion push the silhouette past the outline tolerance.
        return np.minimum(t, np.maximum(-d2, 0) + 0.4 * tol)

    seen_centre, seen_area = centre[seen], area[seen]
    seen_d2 = signed_distance_2d(p, seen_centre[:, :2])
    threshold = 1e9
    if target > 0:
        # Calibrate against the same "counts as moss" rule used on the final
        # mesh, so the thin cushion edge does not eat into the coverage.
        low, high = -3.0, 3.0
        for _ in range(30):
            threshold = (low + high) / 2
            share = seen_area[thickness(seen_centre, seen_d2, normal[seen, 1]) > moss_thick * 0.15].sum() / seen_area.sum()
            low, high = (threshold, high) if share > target else (low, threshold)

    moss_t = thickness(points, np.broadcast_to(d_out[..., None], field.shape), upward_grid)
    verts, quads = surface_nets(closed(field - moss_t), origin, h)
    centre, normal, area = face_stats(verts, quads)
    face_d2 = signed_distance_2d(p, centre[:, :2])
    is_moss = thickness(centre, face_d2, normal[:, 1]) > moss_thick * 0.15
    seen = visible(normal)
    coverage = float(area[seen & is_moss].sum() / area[seen].sum())
    # Per-vertex shading hints the material bakes into the texture: how high
    # a point sits on its clump (light tips) and how far inside the patch it
    # is (dark roots and fringe).
    shade = np.column_stack([clumps(verts), edge(verts)])

    guide = Mesh("gameplay_section", 0)
    triangulate_cap(guide, p, lambda x, y: 0)
    return dict(
        spec=dict(spec, construction="sdf", camera_basis=camera_basis(spec).tolist()),
        mesh=dict(vertices=np.round(verts, 6).tolist(), faces=quads.tolist(),
                  materials=is_moss.astype(int).tolist(), shade=np.round(shade, 4).tolist()),
        gameplay_section=guide.dump(), cell_count=count,
        chunk_seeds=seeds.tolist(), moss_threshold=threshold, moss_coverage_field=coverage,
    )
