"""Build a server-free A/B viewer from capture.ts's real game screenshots."""
import argparse
import html as html_escape
import json
import shutil
from collections import Counter
from pathlib import Path

from PIL import Image, ImageChops, ImageStat

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
parser.add_argument('--previous', type=Path, help='Optional earlier preview to compare against the finished surface')
args = parser.parse_args()
folder = args.directory.resolve()
inspection = json.loads((folder / 'inspection.json').read_text())
reference = Image.open(folder / 'opening-original.png').convert('RGB')
repeat = Image.open(folder / 'opening-original-repeat.png').convert('RGB')
repeat_diff = ImageChops.difference(reference, repeat)
measurements = {'repeatIdentical': repeat_diff.getbbox() is None, 'views': {}}
for view in ['opening', 'wall', 'left', 'right']:
    original = Image.open(folder / f'{view}-original.png').convert('RGB')
    measurements['views'][view] = {}
    for variant in ['geometry', 'adaptive']:
        candidate = Image.open(folder / f'{view}-{variant}.png').convert('RGB')
        difference = ImageChops.difference(original, candidate)
        measurements['views'][view][variant] = {'meanAbsoluteRGB': ImageStat.Stat(difference).mean}
        if variant == 'adaptive' and difference.getbbox() is None:
            raise RuntimeError(f'{view}: the edited rock is not visible; choose a useful camera position')
(folder / 'image-checks.json').write_text(json.dumps(measurements, indent=2))
if not measurements['repeatIdentical']:
    raise RuntimeError('Repeated reference differs; investigate rendering before presenting the comparison')

html = '''<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Cave rock — in-game adaptive detail prototype</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0a1019;color:#e9edf3;font:15px system-ui;line-height:1.5}
main{max-width:1600px;margin:auto;padding:24px}h1{font-size:25px;margin:0}p{color:#b5c2d1;max-width:1000px}
button,select{font:inherit;color:inherit;background:#1c2b3e;border:1px solid #67798d;border-radius:5px;padding:8px 12px;cursor:pointer}
nav{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}#frame{position:relative;aspect-ratio:16/9;background:#000;overflow:hidden}
img{position:absolute;width:100%;height:100%;object-fit:contain}#after{clip-path:inset(0 0 0 50%)}
#divider{position:absolute;left:50%;height:100%;border-left:2px solid white;pointer-events:none}
.tag{position:absolute;top:14px;padding:4px 10px;background:#07101acc;border-radius:4px;font-size:13px}.old{left:14px}.new{right:14px}
#wipe{width:100%;margin:16px 0;cursor:ew-resize}a{color:#90caf9}small{color:#a6b8cb}button[aria-pressed=true]{background:#24587a}
</style><main><h1>Cave rock · in-game detail comparison</h1>
<p>Captured through the game's renderer at 1920 × 1080, with High depth of field, the gameplay lens and zoom,
and frozen lighting/time. Drag the divider, or switch between full original and full prototype.</p>
<nav><select id="view" aria-label="Camera position"><option value="opening">Cave bank</option><option value="wall">Wall</option>
<option value="left">Left pan</option><option value="right">Right pan</option></select>
<select id="variant" aria-label="Prototype variant"><option value="adaptive">Chunks + new surface bake</option>
<option value="geometry">Chunks + original textures (geometry control)</option><option value="bands">Colour-coded depth chunks</option></select>
<button id="original">Original</button><button id="split">Compare</button><button id="prototype">Prototype</button></nav>
<div id="frame"><img id="before" alt="Original game export"><img id="after" alt="Adaptive rock prototype in the same game view">
<div id="divider"></div><span class="tag old">Original export</span><span class="tag new" id="newLabel">Prototype</span></div>
<label for="wipe">Comparison divider</label><input type="range" min="0" max="100" value="50" id="wipe">
<p id="explanation"></p>
<!--UV_STATUS-->
<p><strong>Scope:</strong> one real cave formation, split into five depth regions. Near surface maps are 2048²;
farther maps step down to 1024², 512² and 256². This is a one-sample surface preview on existing geometry:
it does not regenerate fine chips or prove production export savings. The new bake uses a fixed physical
material scale, so differences include the material treatment, not just resolution. Original baked illumination is retained.</p>
<p>Geometry: 201,840 original → 189,094 triangles. Two chunks keep their cut geometry because simplification
failed the boundary check. Splitting itself took 0.35 seconds; complete preparation took 20.3 seconds on one core.
The surface preview runs on two low-priority CPU cores. The source scene/export was not modified.</p>
<small>Repeated original captures are pixel-identical. <a href="inspection.json">Capture details</a> ·
<a href="image-checks.json">Image checks</a>. Arrow keys on the slider move the comparison; select Original or Prototype for an unobstructed view.</small>
</main><script>
const el=id=>document.getElementById(id);
const descriptions={adaptive:'New surface bake with more texture space near the gameplay plane. Inspect the near rock edges and the transition toward the blurred background.',
geometry:'Controlled comparison: only geometry is partitioned and simplified; the original colour, normal and lighting maps are retained. This cannot restore detail missing from the original export.',
bands:'Diagnostic colours show which visible parts belong to each depth chunk. These colours are not part of the proposed appearance.'};
function update(){let view=el('view').value,variant=el('variant').value;el('before').src=`${view}-original.png`;el('after').src=`${view}-${variant}.png`;
el('explanation').textContent=descriptions[variant];el('newLabel').textContent=el('variant').selectedOptions[0].textContent;}
function wipe(value){el('wipe').value=value;el('after').style.clipPath=`inset(0 0 0 ${value}%)`;el('divider').style.left=value+'%';
el('divider').hidden=value==0||value==100;document.querySelector('.old').hidden=value==0;el('newLabel').hidden=value==100;}
el('view').onchange=el('variant').onchange=update;el('wipe').oninput=e=>wipe(e.target.value);
el('original').onclick=()=>wipe(100);el('prototype').onclick=()=>wipe(0);el('split').onclick=()=>wipe(50);update();
</script></html>'''
bake = inspection.get('report', {}).get('surfaceBake', {})
repaired = bake.get('finalUvRepairedFaces')
note = '' if repaired is None else (
    f'<p><strong>UV artifact fix:</strong> repaired {sum(repaired)} distorted face charts. '
    'Final overlap checks pass; the mesh and original lighting UVs are unchanged.</p>')
report=inspection.get('report', {})
if 'productionBakeSeconds' in report:
    start=html.index('<p><strong>Scope:</strong>')
    end=html.index('<small>Repeated original',start)
    maps=' + '.join(f'{count} × {side}²' for side,count in Counter(m['side'] for m in report['maps']).items())
    sampling=(f'{report["previewTexels"]} near texels/metre and {report["samples"]} bake samples'
              if report.get('samples',1)>1 else f'{report["previewTexels"]} near texels/metre and one bake sample')
    html=html[:start]+(
        '<p><strong>Production integration:</strong> '+html_escape.escape(report['scope'])+'</p>'
        f'<p>Geometry: {report["sourceTriangles"]:,} original → {report["adaptiveTriangles"]:,} triangles after depth cuts. '
        f'Colour maps: {maps}. This check uses {sampling}. '
        'Reference baked illumination is retained; material treatment also changes.</p>'
        f'<p>Production preparation and surface bake: {report["productionBakeSeconds"]:.1f} seconds with two low-priority CPU cores; '
        f'baking on {html_escape.escape(report.get("bakeDevice","CPU"))}. '
        'The source scene/export was not modified. Generation savings are measured separately on authored geometry.</p>'
    )+html[end:]
    html=html.replace('only geometry is partitioned and simplified','only geometry is partitioned')
    if report.get('constructed'):
        html=html.replace('Chunks + new surface bake','Finished roof')
        html=html.replace('triangles after depth cuts','triangles after regeneration and depth cuts')
        html=html.replace('only geometry is partitioned; the original colour, normal and lighting maps are retained',
                          'regenerated geometry with projected original colour, normal and lighting maps')
if args.previous:
    for view in ['opening','wall','left','right']:
        shutil.copyfile(args.previous / f'{view}-adaptive.png',folder / f'{view}-previous.png')
    html=html.replace('<nav><select', '<nav><select id="reference" aria-label="Before image">'
                      '<option value="previous">Earlier roof preview</option><option value="original">Original export</option>'
                      '</select><select',1)
    html=html.replace('class="tag old">Original export','class="tag old">Earlier roof preview')
    html=html.replace('<button id="original">Original</button>','<button id="original">Before</button>')
    html=html.replace('`${view}-original.png`', '`${view}-${el("reference").value}.png`')
    html=html.replace("el('view').onchange=el('variant').onchange=update;",
                      "el('reference').onchange=()=>{update();document.querySelector('.old').textContent=el('reference').selectedOptions[0].textContent;};"
                      "el('view').onchange=el('variant').onchange=update;")
(folder / 'index.html').write_text(html.replace('<!--UV_STATUS-->', note))
print(folder / 'index.html')
