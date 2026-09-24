# Jungle vines v3

V3 keeps the dark stems and sparse hanging leaves, and focuses variation on the
braid itself. It removes v2's added upper hooks, tapered terminal growths, and
split-and-rejoin shoots. The three braided stems now change twist spacing,
separation, and thickness along their length using seeded smooth profiles. The
braided stems taper smoothly at both ends and are capped without added pointed
growths.

The earlier generators and their exports remain in `procedural_vines.py`,
`procedural_vines_v2.py`, `vine_output`, and `vine_output_v2`.

Export v3's curtain, cascade, and tangle variants at three LODs:

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python .\procedural_vines_v3.py -- --out .\vine_output_v3
```

Use `--variant curtain`, `--variant cascade`, or `--variant tangle` for one
variant, and `--seed 1234` for a repeatable alternate arrangement. Run
`render_vines_preview_v3.py` in Blender background mode to regenerate the full
preview and close view. Units are metres; vines extend down local negative Z.
The GLBs are visual scenery without gameplay collision or grab metadata.
