"""Brush stamps: what the paint IS for the ivy and the moss add-ons.

A stamp is (centre, surface normal, radius, signed strength) in the host's local
frame; the stamps in painting order are the whole of the paint. They live as the
vertices of a face-less mesh the grown object points at, with the normal, radius
and strength as point attributes: a mesh keeps thousands of them compactly in the
.blend and reads back with foreach_get.

The attributes were `moss_normal`, `moss_radius` and `moss_strength` until
2026-10-02, when the moss add-on of the time became the ivy and the names went
neutral; a mesh with the old names still reads, and the next write renames them."""

from dataclasses import dataclass

import numpy as np

ATTRS = (("stamp_normal", "FLOAT_VECTOR"), ("stamp_radius", "FLOAT"), ("stamp_strength", "FLOAT"))
LEGACY = {"stamp_normal": "moss_normal", "stamp_radius": "moss_radius", "stamp_strength": "moss_strength"}


@dataclass
class Stamps:
    """Brush stamps in the host's LOCAL frame, in painting order."""

    position: np.ndarray  # (S, 3)
    normal: np.ndarray  # (S, 3)
    radius: np.ndarray  # (S,) world metres
    strength: np.ndarray  # (S,) > 0 paints, < 0 erases

    @staticmethod
    def empty():
        return Stamps(np.zeros((0, 3)), np.zeros((0, 3)), np.zeros(0), np.zeros(0))

    def __len__(self):
        return len(self.radius)

    def appended(self, new):
        """These stamps followed by `new`, a list of (position, normal, radius, strength)."""
        pos, nrm, rad, st = (np.array(x, dtype=np.float64) for x in zip(*new))
        return Stamps(
            np.concatenate([self.position, pos]),
            np.concatenate([self.normal, nrm]),
            np.concatenate([self.radius, rad]),
            np.concatenate([self.strength, st]),
        )


def carried(stamps, src, dst):
    """Stamps in the frame `src` (a host's 4x4 world matrix) carried into the
    frame `dst`: for a growth merged into another, whose paint is in its own
    frame host's local frame."""
    a, b = np.array(src, dtype=np.float64), np.array(dst, dtype=np.float64)
    m = np.linalg.inv(b) @ a
    pos = stamps.position @ m[:3, :3].T + m[:3, 3]
    nrm = stamps.normal @ np.linalg.inv(a[:3, :3]) @ b[:3, :3]  # to world by the inverse transpose, then back
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    return Stamps(pos, nrm, stamps.radius.copy(), stamps.strength.copy())


def concatenated(first, then):
    """`first` followed by `then`, painting order kept."""
    return Stamps(*(np.concatenate([x, y]) for x, y in zip(
        (first.position, first.normal, first.radius, first.strength),
        (then.position, then.normal, then.radius, then.strength))))


def _attr(me, name):
    a = me.attributes.get(name)
    return a if a is not None else me.attributes.get(LEGACY[name])


def read(me):
    if me is None or len(me.vertices) == 0:
        return Stamps.empty()
    n = len(me.vertices)
    pos = np.empty(n * 3, np.float32)
    me.vertices.foreach_get("co", pos)
    nrm = np.empty(n * 3, np.float32)
    _attr(me, "stamp_normal").data.foreach_get("vector", nrm)
    rad = np.empty(n, np.float32)
    _attr(me, "stamp_radius").data.foreach_get("value", rad)
    st = np.empty(n, np.float32)
    _attr(me, "stamp_strength").data.foreach_get("value", st)
    return Stamps(
        pos.reshape(-1, 3).astype(np.float64),
        nrm.reshape(-1, 3).astype(np.float64),
        rad.astype(np.float64),
        st.astype(np.float64),
    )


def write(me, stamps):
    me.clear_geometry()
    for old in LEGACY.values():
        if old in me.attributes:
            me.attributes.remove(me.attributes[old])
    n = len(stamps)
    for name, kind in ATTRS:
        if name not in me.attributes:
            me.attributes.new(name, kind, "POINT")
    if n == 0:
        return
    me.vertices.add(n)
    me.vertices.foreach_set("co", stamps.position.astype(np.float32).ravel())
    me.attributes["stamp_normal"].data.foreach_set("vector", stamps.normal.astype(np.float32).ravel())
    me.attributes["stamp_radius"].data.foreach_set("value", stamps.radius.astype(np.float32))
    me.attributes["stamp_strength"].data.foreach_set("value", stamps.strength.astype(np.float32))
    me.update()


def new_mesh(name):
    import bpy

    me = bpy.data.meshes.new(name)
    write(me, Stamps.empty())
    return me
