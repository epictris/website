"""Size-driven, depth-scaled cell seeds without a fixed candidate budget."""
import math
import numpy as np


def layers(lo, hi, scale, size, density, metric, rng):
    """Jittered strata with the requested local volume per seed.

    Yield one depth layer at a time, so fine settings don't allocate a large
    volume-sized candidate pool. Unequal axis spacings retain the stone metric.
    """
    base = (float(np.prod(metric)) / density) ** (1 / 3) * size / np.asarray(metric)
    y = float(lo[1])
    while y < hi[1]:
        step = base * scale(y)
        end = min(float(hi[1]), y + step[1])
        if end <= y:
            raise ValueError('Stone sampling requires a positive camera distance and stone size')
        nx, nz = max(1, math.ceil((hi[0]-lo[0])/step[0])), max(1, math.ceil((hi[2]-lo[2])/step[2]))
        # Chunk even a very wide layer; random draws retain their order.
        for start in range(0, nx*nz, 4096):
            ids = np.arange(start, min(start+4096, nx*nz))
            jitter = rng.uniform(.1, .9, (len(ids), 3))
            points = np.column_stack((lo[0]+(ids//nz+jitter[:, 0])*(hi[0]-lo[0])/nx,
                                      y+jitter[:, 1]*(end-y),
                                      lo[2]+(ids%nz+jitter[:, 2])*(hi[2]-lo[2])/nz))
            yield points, float(np.linalg.norm(step))
        y = end


def surface_seeds(tree, lo, hi, scale, size, density, metric, rng, inside, *, with_ids=False):
    """Keep the volume lattice's surface band; the existing core fills inside.

    The band is a full lattice diagonal wide, retaining the nearby seeds that
    can own the surface, while avoiding stone work deep inside a large solid.
    With `with_ids`, also return each survivor's original lattice-candidate ID;
    these identities do not shift when another candidate is filtered out.
    """
    kept, identities, candidates = [], [], 0
    for points, band in layers(lo, hi, scale, size, density, metric, rng):
        ids = np.arange(candidates, candidates+len(points))
        candidates += len(points)
        near = np.array([tree.find_nearest(p, band)[0] is not None for p in points])
        points, ids = points[near], ids[near]
        if len(points):
            mask = inside(tree, points)
            points, ids = points[mask], ids[mask]
            if len(points):
                kept.append(points)
                identities.append(ids)
    if not kept:
        # A guide smaller/thinner than one requested cell still needs one
        # stone. Step just inside its closest surface instead of depending
        # on a random bounding-box sample hitting that thin volume.
        point, normal, _, _ = tree.find_nearest((lo+hi)/2)
        if point is not None:
            fallback = np.array([point-normal*max(float(np.linalg.norm(hi-lo))*1e-7, 1e-7)])
            if inside(tree, fallback)[0]:
                result = (fallback, candidates)
                return (*result, np.array([candidates])) if with_ids else result
        raise ValueError('No interior stone seed found in the guide')
    result = (np.concatenate(kept), candidates)
    return (*result, np.concatenate(identities)) if with_ids else result


def stone_rng(seed, identity, branch=0, stream=0):
    """Randomness belongs to a lattice candidate, before any mesh filtering.

    Stable candidate and split-branch IDs prevent dropping/merging one stone
    from changing every later slope or bevel. Streams separate construction
    decisions without relying on how many random draws an earlier pass made.
    """
    return np.random.default_rng(np.random.SeedSequence([int(seed), int(identity), int(branch), int(stream)]))
