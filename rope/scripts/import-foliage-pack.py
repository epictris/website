"""Import only source/art assets from the supplied archive; leave the old pack intact."""
from pathlib import Path
from zipfile import ZipFile

root = Path(__file__).resolve().parents[1]
dest = root / 'src/render3d/foliage'
prefix = 'hanging-vines-share/source/src/'
with ZipFile(root / 'artifacts/hanging-vines/hanging-vines-share.zip') as archive:
    for entry in archive.infolist():
        if entry.is_dir() or not entry.filename.startswith(prefix):
            continue
        relative = entry.filename[len(prefix):]
        if relative.startswith('vine/') or relative.startswith('assets/') and relative != 'assets/boulder.glb' or relative == 'leafLibrary.ts':
            target = dest / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(entry))
            if relative == 'leafLibrary.ts':
                text = target.read_text(encoding='utf-8')
                text = text.replace('    const img = await loadImage(URL.createObjectURL(file));',
                    '    const objectUrl = URL.createObjectURL(file);\n'
                    '    let img: HTMLImageElement;\n'
                    '    try { img = await loadImage(objectUrl); }\n'
                    '    finally { URL.revokeObjectURL(objectUrl); }')
                target.write_text(text, encoding='utf-8')
    main = archive.read(prefix + 'main.ts').decode()
    start = main.index('function rayToRock(')
    end = main.index('// Fern settings panel.', start)
    scatter = main[start:end]
    scatter = scatter.replace('function rayToRock(', 'function rayToRock(rockSurface: VineSurface, ')
    scatter = scatter.replace('function scoreFernSpot(', 'function scoreFernSpot(rockSurface: VineSurface, ')
    scatter = scatter.replace('rayToRock(from,', 'rayToRock(rockSurface, from,')
    scatter = scatter.replace('function findFernSpots(count: number, spacing: number)', 'export function findFernSpots(rockSurface: VineSurface, soup: Float32Array, fernSettingsUI: FernSettings, existingRoots: THREE.Vector3[], count: number, spacing: number, scatterSeed = 12345)')
    scatter = scatter.replace('let seed = 12345;', 'let seed = scatterSeed;')
    scatter = scatter.replace('scoreFernSpot(point, normal)', 'scoreFernSpot(rockSurface, point, normal)')
    scatter = scatter.replace('ferns.some(f => new THREE.Vector3(...f.recipe.root).distanceTo(cnd.point) < spacing)', 'existingRoots.some(root => root.distanceTo(cnd.point) < spacing)')
    (dest / 'fernPlacement.ts').write_text('import * as THREE from "three";\nimport { VineSurface } from "./vine/hangingVine";\nimport { generateFern, disposeFern, type FernSettings } from "./vine/fern";\n' + scatter, encoding='utf-8')
