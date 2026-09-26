"""3D chunk geometry for dirt-and-moss blocks.

Modelled on ../boulders/stylised_rocks_v5/chunk_geometry.py, but tuned for a
soft, chunky dirt block instead of a fractured rock:

- Far fewer, much broader chunks (area * 3 instead of area * 10).
- Seeds come from farthest-point sampling *followed by* a few Lloyd
  relaxation passes, so chunk sizes are even instead of scattered.
- The chunk transform is near-isotropic (boulders are strongly anisotropic
  with a sharp fracture angle) so joints read as soft lobes, not fracture
  planes.
- Each chunk is gently inflated ("pillowed") outward before the outline
  clip, and carries a much wider bevel fraction than a boulder chunk.
- There is no "natural face" hybrid slab layer: dirt chunks never overlap
  with a second independent slab system, which is what gives boulders their
  sharp secondary fracture planes.
"""
import math
import numpy as np
from scipy.spatial import HalfspaceIntersection, ConvexHull
import shapely
from shapely import Polygon, Point, MultiPoint
from shapely.geometry.polygon import orient


def farthest_point_seeds(p, count, rng):
    """Stratified candidates inside the outline, thinned by farthest-point
    sampling so the first pass of seeds is already roughly even."""
    candidates = []
    for _ in range(count * 2000):
        xy = rng.uniform(p.bounds[:2], p.bounds[2:])
        if p.contains(Point(xy)):
            candidates.append(xy)
        if len(candidates) >= max(count * 40, 200):
            break
    if len(candidates) < count:
        raise ValueError("Unable to sample enough chunk seeds inside the outline.")
    candidates = np.array(candidates)
    chosen = [candidates[int(rng.integers(len(candidates)))]]
    while len(chosen) < count:
        distances = np.min(np.linalg.norm(candidates[:, None, :] - np.array(chosen)[None, :, :], axis=2), axis=1)
        best = int(np.argmax(distances * rng.uniform(0.9, 1.1, len(distances))))
        chosen.append(candidates[best])
    return np.array(chosen)


def lloyd_relax(seeds, bounds_poly, iterations, rng):
    """Move each seed toward the centroid of its own Voronoi cell, clipped to
    the outline, for a few passes. Evens out chunk footprint areas."""
    pts = seeds.copy()
    for _ in range(iterations):
        if len(pts) < 2:
            break
        diagram = shapely.voronoi_polygons(MultiPoint([tuple(v) for v in pts]), extend_to=bounds_poly.envelope)
        updated = pts.copy()
        used = set()
        for cell in diagram.geoms:
            clipped = cell.intersection(bounds_poly)
            if clipped.is_empty or clipped.area <= 1e-12:
                continue
            owner = None
            for i, seed in enumerate(pts):
                if i in used:
                    continue
                if cell.contains(Point(seed)) or cell.distance(Point(seed)) < 1e-9:
                    owner = i
                    break
            if owner is None:
                dists = np.linalg.norm(pts - np.array(clipped.centroid.coords[0]), axis=1)
                owner = int(np.argmin(dists))
            used.add(owner)
            updated[owner] = np.array(clipped.centroid.coords[0])
        pts = updated
    return pts


def build_dirt_chunks(spec):
    from rockgen import Mesh, prism, triangulate_cap, polygons
    from volume_geometry import camera_basis

    p = orient(Polygon(spec["outer"], spec["holes"]), 1)
    depth = float(spec["depth"])
    rng = np.random.default_rng(int(spec["seed"]) + 4110)
    area = p.area

    # Larger, more even chunks than a fractured boulder: ~3/m^2, clamped to a
    # sane range regardless of outline size.
    count = int(np.clip(round(area * 3), 2, 24))

    # A buried support keeps the block solid through the gameplay plane
    # (the depth=0 cross-section must match the outline closely, same as
    # boulder v5's buried_seam_support -- the XY inset stays tight for
    # that) and under any narrow seams between chunks. What changed from
    # the first pass: it is now a much SHALLOWER slab in depth
    # (support_half_depth, not the XY inset) than before. A support that
    # reaches close to the front/back surface reads as a flat slab/prism
    # showing through the gaps between chunks, hiding the individual clod
    # shapes the chunks are meant to form; keeping it shallow means the
    # chunks -- which reach much further forward/back -- are what the
    # camera actually sees almost everywhere.
    inset = spec["tolerance"] * 0.55
    support_half_depth = depth * 0.16
    support = p.buffer(-inset, join_style="mitre", mitre_limit=2)
    coreparts = [prism(q, -support_half_depth, support_half_depth, f"buried_support_{i}", 0)
                 for i, q in enumerate(polygons(support))]
    guard = 0
    while p.boundary.hausdorff_distance(support.boundary) > spec["tolerance"] * 0.90 and inset > 1e-6 and guard < 20:
        inset *= 0.5
        support = p.buffer(-inset, join_style="mitre", mitre_limit=2)
        coreparts = [prism(q, -support_half_depth, support_half_depth, f"buried_support_{i}", 0)
                     for i, q in enumerate(polygons(support))]
        guard += 1

    seeds2d = farthest_point_seeds(p, count, rng)
    seeds2d = lloyd_relax(seeds2d, p, 3, rng)
    depth_z = rng.uniform(-depth * 0.5, depth * 0.5, count)
    seeds = np.column_stack([seeds2d, depth_z])

    bounds = np.array([[p.bounds[0], p.bounds[1], -depth * 0.64],
                        [p.bounds[2], p.bounds[3], depth * 0.64]])
    # Near-isotropic: only a whisper of shear/skew, unlike the boulder's
    # sharply anisotropic fracture transform.
    transform = np.array([[1, 0.03, 0.02], [0, 0.97, -0.02], [0, 0, 0.92]])
    transformed = seeds @ transform.T

    parts = list(coreparts)
    chunk_sizes = []
    for i, (seed, s) in enumerate(zip(seeds, transformed)):
        planes = []
        for j, other in enumerate(transformed):
            if i == j:
                continue
            delta = other - s
            normal = delta @ transform
            planes.append([*normal, -(np.dot(other, other) - np.dot(s, s)) / 2])
        for axis in range(3):
            n = np.zeros(3)
            n[axis] = 1
            planes.append([*n, -bounds[1, axis]])
            planes.append([*(-n), bounds[0, axis]])
        vertices = HalfspaceIntersection(np.array(planes), seed).intersections
        centre = vertices.mean(axis=0)
        # Mild depth-scale jitter and a small tilt: chunks stay near-cubic.
        vertices = centre + (vertices - centre) * np.array([
            rng.uniform(0.94, 1.0), rng.uniform(0.94, 1.0), rng.uniform(0.97, 1.05)])
        vertices[:, 2] += (vertices[:, :2] - centre[:2]) @ rng.uniform(-0.06, 0.06, 2)
        # Shrink each chunk in from its Voronoi cell boundary before the
        # outline clip: this is what leaves a real, persistent gap between
        # neighbouring chunks for the per-chunk bevel below to carve into a
        # wide, visible groove after union, instead of the two chunks
        # meeting exactly at their bisector with no seam left to see. The
        # gaps themselves are bridged and made solid by the buried support
        # underneath, not left as actual holes.
        vertices = centre + (vertices - centre) * rng.uniform(0.86, 0.93)
        hull = ConvexHull(vertices)
        size = float(np.max(vertices.max(axis=0) - vertices.min(axis=0)))
        chunk_sizes.append(size)
        mesh = Mesh(f"dirt_chunk_{i:03d}", 0)
        for tri in hull.simplices:
            mesh.face(vertices[tri])
        part = mesh.dump()
        part["clip_to_outline"] = True
        # A wide bevel fraction: combined with the round-toward-a-blob pass
        # applied in Blender (dirt_build.assemble_dirt_base) and a light
        # post-union smooth, this is what makes each chunk read as one big
        # rounded clod with a soft groove at its neighbours, rather than a
        # flat-faced prism.
        part["chunk_bevel"] = size * float(rng.uniform(0.20, 0.28))
        parts.append(part)

    clip = prism(p, -depth * 1.3, depth * 1.3, "polygon_envelope", 0)
    guide = Mesh("gameplay_section", 0)
    triangulate_cap(guide, p, lambda x, y: 0)
    return dict(
        spec=dict(spec, construction="volume", camera_basis=camera_basis(spec).tolist()),
        parts=parts, clip=clip, cell_count=count,
        gameplay_section=guide.dump(),
        chunk_seeds=seeds.tolist(), chunk_sizes=chunk_sizes,
    )
