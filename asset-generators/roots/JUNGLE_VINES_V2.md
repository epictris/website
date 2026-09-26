# Jungle vines v2

This version preserves `procedural_vines.py` and `vine_output`. Its generator is
`procedural_vines_v2.py`, with exports in `vine_output_v2`.

V2 gives the hanging cluster thicker main vines and shorter, thinner secondary
vines. The three stems in each braid change pitch, separation, and thickness
along their length. Main vines grow one or two slender shoots that split away
and rejoin. Small leaves keep their downward hang but vary in size and roll;
their positions leave an irregular open stretch rather than repeating at fixed
intervals. Subtle light and dark stem materials emphasize raised strands and
recesses. Curved upper attachments and tapered terminal growths shape the ends.

Export all three variants and LODs in Blender 5.x:

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python .\procedural_vines_v2.py -- --out .\vine_output_v2
```

Use `--variant curtain`, `--variant cascade`, or `--variant tangle` for one
variant, and `--seed 1234` for a repeatable alternate arrangement. Run
`render_vines_preview_v2.py` in Blender background mode to regenerate the full
preview and close view. Units are metres; attachments are near local Z=0 and
vines hang toward negative Z. The GLBs are visual scenery meshes with no
gameplay collision or grab metadata.
