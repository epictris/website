"""Reproduce the moss clear-of-rock blow-up headlessly (plans/moss-clear-blowup.md).

    cd rope
    BLENDER_USER_CONFIG=$(mktemp -d) blender -b --factory-startup \
        assets-src/scenes/river-autosave-2026-10-16-2202.blend \
        --python plans/moss-clear-blowup/repro.py -- A

Case A: a stroke on Terrace.002's front face at x 28.3..29.5, z -5.4 that joins
Cube.002, over the crevices where Cube.002's chunks meet; before the fix
`_clear_of_rock` never converged there (more triangles in the rock every round).
Case B: x 24.7..25.9, z -3.9 on Terrace.002 alone; converges, after splitting
the mound 17-fold (the decimate ignores the rock). BIG: a stroke of six rows,
about the size of the one that froze Blender. SCAN: 30 strokes over the front
face, each grown and dropped, one RESULT line each (no debug rounds).

A stroke is laid the way the brush lays one (stampbrush/brush.py `cast` and
`_stamp_at`): rays along +y from y = -5, the first paintable mesh hit, a stamp
every radius x spacing, every paintable mesh within the radius joined. Settings
are Terrace.003.moss's (a printed edge).

The pass is aborted once the mound passes CAP times the triangles it was given
(env CAP, default 40), so this is safe on code without a bound; CAP=0 lets it
run. Prints the debug rounds (single cases) and a RESULT line per stroke."""

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tools", "blender"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402

import moss  # noqa: E402
from moss import build, ops  # noqa: E402
from moss.stampbrush import stamps as stamp_io  # noqa: E402
from moss.stampbrush.brush import paintable  # noqa: E402
from moss.stampbrush.hosts import Reach  # noqa: E402

RADIUS, STRENGTH, SPACING = 0.25, 0.6, 0.25  # the brush's defaults (moss/settings.py)
ROW = RADIUS * 0.8
CASES = {  # name: (x from, x to, z from, z to)
    "A": (28.3, 29.5, -5.4, -5.4),
    "B": (24.7, 25.9, -3.9, -3.9),
    "BIG": (25.5, 28.5, -5.4, -4.4),
}
SCAN = [(x, x + 1.2, z, z) for z in np.arange(-6.4, -2.6, 0.5) for x in np.arange(22.3, 29.3, 1.2)][:30]
CAP = float(os.environ.get("CAP", "40"))

case = (sys.argv[sys.argv.index("--") + 1:] or ["A"])[0]
moss.register()
build.DEBUG = case != "SCAN"
if "LIMIT_SECONDS" in os.environ:  # to see the time limit fail a build
    build.BUILD_SECONDS = float(os.environ["LIMIT_SECONDS"])
if "BUDGET" in os.environ:  # to see the split budget fail one
    build.CLEAR_SPLIT_BUDGET = int(os.environ["BUDGET"])


class Blowup(Exception):
    pass


given = {}
_clear, _split = build._clear_of_rock, build._split_edges


def clear(v, t, attrs, rock, c, weld=None, **kw):
    given["n"] = len(t)
    out = _clear(v, t, attrs, rock, c, weld, **kw)
    given["out"] = f"{len(t)} -> {len(out[1])} triangles, {out[4]} edges split, {out[5] * 1e4:.1f} cm2 left in the rock"
    return out


def split(v, t, attrs, edges):
    out = _split(v, t, attrs, edges)
    if CAP and len(out[1]) > CAP * given["n"]:
        raise Blowup(f"{given['n']} -> {len(out[1])} triangles, aborted at CAP={CAP:g}")
    return out


build._clear_of_rock, build._split_edges = clear, split

scene = bpy.context.scene
dg = bpy.context.evaluated_depsgraph_get()
host = bpy.data.objects["Terrace.002"]
template = bpy.data.objects["Terrace.003.moss"]
reach = Reach([o for o in scene.objects if paintable(o) and o.visible_get()], dg)


def stroke(name, x0, x1, z0, z1):
    ob = ops.create_moss(host, scene, template)
    d = Vector((0.0, 1.0, 0.0))
    new = []
    for z in np.arange(z0, z1 + 1e-9, ROW):
        for x in np.arange(x0, x1, RADIUS * SPACING):
            origin, hit_ob = Vector((x, -5.0, z)), None
            for _ in range(16):  # as `cast`: look through what is not paintable, at most 16 times
                hit, loc, nrm, _i, h, _m = scene.ray_cast(dg, origin, d)
                if not hit:
                    break
                if paintable(h.original):
                    hit_ob = h.original
                    break
                origin = loc + d * 1e-4
            if hit_ob is None:
                continue
            have = {o.name for o in ops.hosts_of(ob)}
            for o in [hit_ob, *reach.near(loc, RADIUS)]:
                if o.name not in have:
                    ops.join(ob, o)
                    have.add(o.name)
            mw = host.matrix_world
            new.append(((mw.inverted() @ loc)[:], (mw.to_3x3().transposed() @ nrm).normalized()[:], RADIUS, STRENGTH))
    if not new:
        bpy.data.objects.remove(ob)
        return
    stamp_io.write(ob.moss.stamps, stamp_io.read(ob.moss.stamps).appended(new))
    given.clear()
    t0 = time.time()
    try:
        ops.rebuild(ob)
        verdict = f"built, {ob.moss.triangles} triangles, status {ob.moss.status!r}"
    except Blowup as e:
        verdict = f"BLOWUP {e}"
    print(f"RESULT {name} x {x0:.1f}..{x1:.1f} z {z0:.1f}..{z1:.1f}, {len(new)} stamps on {[o.name for o in ops.hosts_of(ob)]}: "
          f"clear {given.get('out', '-')}; {verdict}; {time.time() - t0:.1f} s", flush=True)
    bpy.data.objects.remove(ob)


for args in (SCAN if case == "SCAN" else [CASES[case]]):
    stroke(case, *args)
