"""Four reusable flat-polygon examples for the side-view root generator."""
import numpy as np


def limb(name, points, widths, depth, broken_start=False, broken_tip=True):
    """Draw a flat ribbon around a few authored stations; widths are full width."""
    p = np.asarray(points, dtype=float)
    tangent = np.empty_like(p)
    tangent[0] = p[1] - p[0]
    tangent[-1] = p[-1] - p[-2]
    tangent[1:-1] = p[2:] - p[:-2]
    tangent /= np.linalg.norm(tangent, axis=1)[:, None]
    normal = np.column_stack((-tangent[:, 1], tangent[:, 0]))
    half = np.asarray(widths)[:, None] / 2
    polygon = np.concatenate((p + normal * half, (p - normal * half)[::-1]))
    n = len(polygon)
    ends = ([len(p) - 1] if broken_tip else []) + ([n - 1] if broken_start else [])
    return dict(id=name, polygon=polygon.round(6).tolist(), depth=depth,
                grab_edges=list(range(n)), corner_rounding=.82, broken_edges=ends)


def samples():
    designs = [
        ('01_tall_fork', 'Tall fork', 1407, [
            limb('fork_trunk', [(0,0),(-.13,.52),(.02,1.06),(-.08,1.60),(.16,2.17)],
                 [.57,.65,.50,.56,.43], .48, True, False),
            limb('fork_left', [(-.01,1.42),(-.39,1.95),(-.79,2.31),(-1.05,2.90),(-.97,3.24)],
                 [.50,.43,.33,.25,.16], .35),
            limb('fork_right', [(-.02,1.76),(.46,2.07),(.68,2.60),(1.13,2.94)],
                 [.44,.39,.28,.17], .33),
            limb('fork_spur', [(-.09,.85),(.39,1.09),(.64,1.42)],
                 [.32,.23,.13], .22),
        ]),
        ('02_sweeping_hook', 'Sweeping hook', 2219, [
            limb('hook_body', [(-1.70,.08),(-1.22,.22),(-.65,.28),(-.08,.53),(.53,.79),(1.08,1.25)],
                 [.63,.67,.53,.47,.35,.24], .43, True, False),
            limb('hook_tip', [(.72,.96),(1.08,1.27),(1.22,1.69),(1.06,2.05),(.79,2.23)],
                 [.31,.27,.22,.16,.10], .24),
            limb('hook_spur', [(-.67,.28),(-.66,.72),(-.40,1.10)],
                 [.34,.26,.14], .23),
        ]),
        ('03_hanging_roots', 'Hanging roots', 3301, [
            limb('canopy_anchor', [(-1.55,2.48),(-.85,2.69),(-.22,2.63),(.42,2.80),(1.37,2.54)],
                 [.39,.53,.60,.45,.26], .43, True, True),
            limb('canopy_left', [(-.91,2.64),(-1.01,2.10),(-.79,1.56),(-.91,.96),(-.64,.41)],
                 [.38,.34,.24,.18,.10], .28),
            limb('canopy_middle', [(-.12,2.66),(.06,2.10),(-.14,1.57),(.08,.97),(.02,.08)],
                 [.43,.36,.30,.20,.11], .31),
            limb('canopy_right', [(.67,2.70),(.75,2.16),(1.10,1.74),(1.22,1.10)],
                 [.33,.29,.23,.13], .26),
        ]),
        ('04_root_arch', 'Root arch', 4487, [
            limb('arch_left', [(-1.48,.10),(-1.33,.67),(-1.23,1.36),(-.79,1.95),(-.20,2.26),(.22,2.28)],
                 [.61,.57,.48,.40,.35,.30], .43, True, False),
            limb('arch_right', [(-.18,2.24),(.47,2.21),(1.07,1.91),(1.39,1.27),(1.55,.63)],
                 [.35,.41,.47,.49,.34], .38, False, True),
            limb('arch_spur', [(-.75,1.98),(-.66,2.49),(-.39,2.86)],
                 [.28,.22,.13], .22),
        ]),
    ]
    return [dict(slug=slug, title=title, seed=seed,
                 data=dict(version=2, units='meters', up_axis='Y', gameplay='2D', roots=roots))
            for slug, title, seed, roots in designs]


if __name__ == '__main__':
    from polygon_roots_2d import validate_shapes
    from sideview_outline import resolve_outlines
    from sideview_surface import connected_groups
    for sample in samples():
        data = validate_shapes(sample['data'])
        resolved = resolve_outlines(data)
        validate_shapes(resolved)
        groups = connected_groups(resolved['roots'])
        assert len(groups) == 1, sample['slug']
        print(sample['title'], ': valid flat outlines, one connected root')
