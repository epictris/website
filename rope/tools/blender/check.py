"""Geometric checks of a generated rock GLB, in headless Blender.

Run by `cli rocks-check --geometry`, never by hand:

    blender -b --factory-startup --python tools/blender/check.py -- file.glb options.json

`options.json` is {"bodies": [indices] or null, "cameras": [names]}. Prints one
line per body, `[check] {json}`, which the CLI turns into its report. The
file-level checks (attributes, UV spans, hashes) are the CLI's own and need no
Blender; these need a BVH (docs/rocks.md, "Diagnosing").

Frames. The importer maps glTF back to Blender's z-up, so as in rocks.py the
front of a rock, the face toward the camera, is at NEGATIVE Blender y, and
Blender z is game up.

- BACK FACES. From each camera, a grid of rays at RAY_SPACING over the body's
  silhouette; a ray whose FIRST hit is a back face (normal . dir > BACK_DOT) is
  a ray looking into a hole or an inside-out shard. Hits are clustered into
  CLUSTER cells. A human judges clusters: a legitimately visible interior (a
  notch seen from above) can show here, so this never fails a build alone.
- COINCIDENT COPLANAR FACES. Faces bucketed by plane (normal to about a
  degree, offset to a millimetre) and tested pairwise for an overlap of
  positive area in that plane: the z-fighting class. Pairs whose faces belong
  to different shards when the file carries _SHARD, all pairs otherwise.
- DEGENERATE TRIANGLES. Area under DEGENERATE_AREA or an edge under
  DEGENERATE_EDGE.
- DARK CAPS. Up-facing faces over CAP_AREA, seen from the raised or the
  head-on camera, whose AO texel at the face's UV centroid reads under
  CAP_DARK: the black-cap failure.
"""

import json
import math
import sys

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

RAY_SPACING = 0.02
# ...widened for a body so large that the grid would pass this many rays per
# camera (each is a Python call; a 40 m wall at 2 cm is a million), and the
# spacing used is reported.
MAX_RAYS = 250_000
CAMERA_DISTANCE = 6.0
BACK_DOT = 0.05
CLUSTER = 0.25
# The coplanar bucket: the normal quantised to about a degree, the plane's
# offset to a millimetre, and an overlap smaller than this is a shared edge.
PLANE_NORMAL_STEPS = 57
PLANE_OFFSET = 0.001
OVERLAP_AREA = 1e-6
DEGENERATE_AREA = 1e-8
DEGENERATE_EDGE = 1e-4
CAP_AREA = 1e-3
CAP_UP = 0.7
CAP_DARK = 0.05

# (yaw, pitch) in degrees about the body centre, looking from the front.
CAMERAS = {
    "head": (0.0, 0.0),
    "above": (0.0, 30.0),
    "left": (-30.0, 0.0),
    "right": (30.0, 0.0),
}


def arrays(obj):
    """World-space (verts, tris) and the per-vertex _SHARD, if present."""
    mesh = obj.data
    mesh.calc_loop_triangles()
    m = np.array(obj.matrix_world)
    v = np.empty(len(mesh.vertices) * 3)
    mesh.vertices.foreach_get("co", v)
    v = v.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
    t = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int64)
    mesh.loop_triangles.foreach_get("vertices", t)
    shard = None
    for name in ("_SHARD", "_shard"):
        if name in mesh.attributes:
            shard = np.empty(len(mesh.vertices))
            mesh.attributes[name].data.foreach_get("value", shard)
            break
    return v, t.reshape(-1, 3), shard


def back_faces(bvh, v, camera):
    """Rays from `camera` over the body's silhouette; the clusters of rays
    whose first hit is a back face."""
    yaw, pitch = (math.radians(a) for a in CAMERAS[camera])
    # Straight on looks along +y (the camera stands at -y); yaw turns about
    # z, pitch raises the camera (it then looks down).
    look = np.array([math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), -math.sin(pitch)])
    right = np.array([math.cos(yaw), -math.sin(yaw), 0.0])
    up = np.cross(right, look)
    centre = (v.min(axis=0) + v.max(axis=0)) / 2
    eye = centre - look * CAMERA_DISTANCE
    # The grid is laid on the plane through the centre facing the camera,
    # over the body's projected extent, so the spacing is 2 cm at the body.
    rel = v - centre
    u, w = rel @ right, rel @ up
    spacing = max(RAY_SPACING, math.sqrt((u.max() - u.min()) * (w.max() - w.min()) / MAX_RAYS))
    us = np.arange(u.min(), u.max() + spacing, spacing)
    ws = np.arange(w.min(), w.max() + spacing, spacing)
    eye_v = Vector(eye.tolist())
    rays = 0
    hits = []
    for a in us:
        for b in ws:
            target = centre + right * a + up * b
            d = target - eye
            d /= np.linalg.norm(d)
            loc, normal, _, _ = bvh.ray_cast(eye_v, Vector(d.tolist()), CAMERA_DISTANCE * 3)
            if loc is None:
                continue
            rays += 1
            if normal.dot(Vector(d.tolist())) > BACK_DOT:
                hits.append(tuple(loc))
    cells = {}
    for p in hits:
        key = tuple(int(math.floor(c / CLUSTER)) for c in p)
        cells.setdefault(key, []).append(p)
    clusters = sorted(
        ({"count": len(ps), "at": [round(float(c), 3) for c in np.mean(ps, axis=0)]} for ps in cells.values()),
        key=lambda c: -c["count"],
    )
    return {"camera": camera, "rays": rays, "back": len(hits), "spacing": spacing, "clusters": clusters}


def tri_clip(subject, clip_poly):
    """Sutherland-Hodgman: `subject` (2D polygon) clipped by the convex,
    counter-clockwise `clip_poly`."""
    out = subject
    n = len(clip_poly)
    for i in range(n):
        if not out:
            break
        a, b = clip_poly[i], clip_poly[(i + 1) % n]
        inp, out = out, []

        def inside(p):
            return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0

        def cross(p, q):
            dx, dy = q[0] - p[0], q[1] - p[1]
            ex, ey = b[0] - a[0], b[1] - a[1]
            den = dx * ey - dy * ex
            if abs(den) < 1e-15:
                return q
            s = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den
            return (p[0] + s * dx, p[1] + s * dy)

        for k in range(len(inp)):
            p, q = inp[k], inp[(k + 1) % len(inp)]
            if inside(q):
                if not inside(p):
                    out.append(cross(p, q))
                out.append(q)
            elif inside(p):
                out.append(cross(p, q))
    return out


def poly_area(p):
    return 0.5 * sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))


def coincident(v, t, shard):
    """Overlapping coplanar face pairs (see the module docstring)."""
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    n = np.cross(b - a, c - a)
    area2 = np.linalg.norm(n, axis=1)
    ok = area2 > 1e-12
    n[ok] /= area2[ok, None]
    d = np.einsum("ij,ij->i", n, a)
    # Faces of opposite orientation on one plane are a solid's two sides
    # touching (a shard against the backing), not z-fighting; only same-facing
    # pairs fight.
    key = np.concatenate([np.round(n * PLANE_NORMAL_STEPS), np.round(d / PLANE_OFFSET)[:, None]], axis=1).astype(np.int64)
    order = np.lexsort(key.T[::-1])
    sk = key[order]
    breaks = np.nonzero(np.any(sk[1:] != sk[:-1], axis=1))[0] + 1
    groups = np.split(order, breaks)
    pairs = []
    tested = 0
    for g in groups:
        g = g[ok[g]]
        if len(g) < 2 or len(g) > 400:
            continue
        # A 2D frame in the plane.
        nn = n[g[0]]
        ax = np.cross(nn, [0, 0, 1] if abs(nn[2]) < 0.9 else [1, 0, 0])
        ax /= np.linalg.norm(ax)
        ay = np.cross(nn, ax)
        tri2 = [[(float(p @ ax), float(p @ ay)) for p in (a[i], b[i], c[i])] for i in g]
        tri2 = [tr if poly_area(tr) >= 0 else tr[::-1] for tr in tri2]
        lo = np.array([np.min(tr, axis=0) for tr in tri2])
        hi = np.array([np.max(tr, axis=0) for tr in tri2])
        for i in range(len(g)):
            for j in range(i + 1, len(g)):
                if shard is not None and shard[t[g[i], 0]] == shard[t[g[j], 0]]:
                    continue
                if (lo[i] > hi[j]).any() or (lo[j] > hi[i]).any():
                    continue
                tested += 1
                inter = tri_clip(tri2[i], tri2[j])
                if len(inter) >= 3 and abs(poly_area(inter)) > OVERLAP_AREA:
                    fa, fb = int(g[i]), int(g[j])
                    pairs.append(
                        {
                            "faces": [fa, fb],
                            "shards": [int(shard[t[fa, 0]]), int(shard[t[fb, 0]])] if shard is not None else None,
                            "area": round(abs(poly_area(inter)) * 1e4, 2),
                            "at": [round(float(x), 3) for x in (a[fa] + b[fa] + c[fa]) / 3],
                        }
                    )
    pairs.sort(key=lambda p: -p["area"])
    return {"pairs": len(pairs), "tested": tested, "shardAware": shard is not None, "top": pairs[:12]}


def degenerate(v, t):
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    area = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
    edge = np.minimum(np.minimum(np.linalg.norm(b - a, axis=1), np.linalg.norm(c - b, axis=1)), np.linalg.norm(a - c, axis=1))
    return {"area": int((area < DEGENERATE_AREA).sum()), "edge": int((edge < DEGENERATE_EDGE).sum()), "of": len(t)}


def ao_image(obj):
    """The body's AO atlas image, and the UV layer it is read through (the
    importer names TEXCOORD_1 "UVMap.001" or similar: the second layer)."""
    mesh = obj.data
    if len(mesh.uv_layers) < 2:
        return None, None
    for mat in mesh.materials:
        if mat is None or not mat.use_nodes:
            continue
        for node in mat.node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image is not None:
                return node.image, mesh.uv_layers[1]
    return None, None


def seen_from(bvh, v, t, faces, camera):
    """Which of `faces` a ray from `camera` to its centroid hits first: the
    ones on screen from there. A buried face is black in the atlas and harmless."""
    yaw, pitch = (math.radians(a) for a in CAMERAS[camera])
    look = np.array([math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), -math.sin(pitch)])
    centre = (v.min(axis=0) + v.max(axis=0)) / 2
    eye = centre - look * CAMERA_DISTANCE
    eye_v = Vector(eye.tolist())
    seen = np.zeros(len(faces), dtype=bool)
    for k, f in enumerate(faces):
        target = v[t[f]].mean(axis=0)
        d = target - eye
        dist = float(np.linalg.norm(d))
        _, _, index, _ = bvh.ray_cast(eye_v, Vector((d / dist).tolist()), dist + 0.01)
        seen[k] = index == f
    return seen


def dark_caps(obj, v, t, bvh):
    image, layer = ao_image(obj)
    if image is None:
        return {"checked": False}
    w, h = image.size
    px = np.empty(w * h * 4, dtype=np.float32)
    image.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)[:, :, 0]
    mesh = obj.data
    uv = np.empty(len(mesh.loops) * 2)
    layer.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    lt = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int64)
    mesh.loop_triangles.foreach_get("loops", lt)
    lt = lt.reshape(-1, 3)
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    n = np.cross(b - a, c - a)
    area = np.linalg.norm(n, axis=1) / 2
    up = n[:, 2] / np.maximum(2 * area, 1e-12)
    caps = np.nonzero((up > CAP_UP) & (area > CAP_AREA))[0]
    # Only the caps someone sees: from the raised camera, or head-on.
    caps = caps[seen_from(bvh, v, t, caps, "above") | seen_from(bvh, v, t, caps, "head")]
    centroid = uv[lt[caps]].mean(axis=1)
    x = np.clip((centroid[:, 0] * w).astype(int), 0, w - 1)
    y = np.clip((centroid[:, 1] * h).astype(int), 0, h - 1)
    ao = px[y, x]
    dark = caps[ao < CAP_DARK]
    worst = sorted(
        ({"face": int(f), "area": round(float(area[f]) * 1e4, 1), "ao": round(float(px[y[k], x[k]]), 3), "at": [round(float(q), 3) for q in (a[f] + b[f] + c[f]) / 3]}
         for k, f in enumerate(caps) if ao[k] < CAP_DARK),
        key=lambda d: -d["area"],
    )
    return {"checked": True, "caps": int(len(caps)), "dark": int(len(dark)), "top": worst[:8]}


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :]
    path, opts_path = argv[0], argv[1]
    with open(opts_path) as f:
        opts = json.load(f)
    only = set(opts.get("bodies") or [])
    cameras = opts.get("cameras") or list(CAMERAS)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    for obj in sorted(bpy.context.scene.objects, key=lambda o: o.name):
        if obj.type != "MESH" or not obj.name.startswith("body-"):
            continue
        index = int(obj.get("rockIndex", obj.name.split("-")[1].split(".")[0]))
        if only and index not in only:
            continue
        v, t, shard = arrays(obj)
        bvh = BVHTree.FromPolygons(v.tolist(), t.tolist())
        out = {
            "body": index,
            "backFaces": [back_faces(bvh, v, cam) for cam in cameras],
            "coincident": coincident(v, t, shard),
            "degenerate": degenerate(v, t),
            "darkCaps": dark_caps(obj, v, t, bvh),
        }
        print("[check] " + json.dumps(out), flush=True)


main()
