# Procedural jungle vines

`procedural_vines.py` generates hanging 3D vine scenery with three dark stems
that twist with changing pitch, spacing, and thickness around each centreline,
sparse narrow leaves that hang downward with
softly cupped surfaces and curved tips, short petioles, and curled tendrils.
Each strand carries roughly two to four leaves over about three metres. The
three seeded forms are **curtain**, **cascade**, and **tangle**. Each has LOD0, LOD1, and LOD2;
lower detail levels use fewer stem segments and leaves. Materials use standard
glTF PBR colors, so the GLBs need no external textures or custom shaders.

Open `procedural_vines.py` in Blender's Scripting workspace and run it to add
the three editable LOD0 variants. To export all variants from a terminal:

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python .\procedural_vines.py -- --out .\vine_output
```

Use `--variant curtain`, `--variant cascade`, or `--variant tangle` for one form.
Use `--seed 1234` to generate a repeatable alternate layout. Change `VARIANTS`
and `LODS` in the script to alter strand count, width, length, sway, leaf
density, curl frequency, and geometric detail. The stem and leaf materials
near the end of `build()` control their separate colours.

The attachment line is near local Z=0; vines extend down negative Z. Blender
exports glTF with Y as the up axis. These are visual scenery meshes and have no
gameplay collision or grab metadata. Use the root workflow in
`SIDEVIEW_ROOTS.md` for climbable geometry.

`vine_output/vine_preview.png` shows the default LOD0 forms, left to right:
curtain, cascade, tangle. Regenerate it with `render_vines_preview.py` in
Blender background mode.
