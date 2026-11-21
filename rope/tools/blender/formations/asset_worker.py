"""Background export-scene build; publish the output only after every asset succeeds."""
import json
import os
from pathlib import Path
import sys
import uuid

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from formations.asset_export import build_scene


def main():
    request = json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text())
    output = Path(request['output'])
    if request.get('source') and output.resolve() == Path(request['source']).resolve():
        raise ValueError('The export must not overwrite its authoring file')
    scene = bpy.data.scenes[request['scene']]
    report = build_scene(scene, request['cache'])
    scene['formation_export_build'] = True
    scene['formation_authoring_file'] = request['source']
    scene['formation_export_report'] = json.dumps(report)
    # Absolute references keep linked scene guides/resources usable after the
    # temporary snapshot is removed. Baked maps are already packed.
    bpy.ops.file.make_paths_absolute()
    temp = output.with_name(f'.{output.stem}-{uuid.uuid4().hex}.blend')
    try:
        bpy.ops.wm.save_as_mainfile(filepath=str(temp), check_existing=False)
        os.replace(temp, output)
    finally:
        if temp.exists(): temp.unlink()
    output.with_suffix('.formations.json').write_text(json.dumps(report, indent=2)+'\n')
    print('FORMATION_EXPORT_OK', json.dumps(report), flush=True)


if __name__ == '__main__': main()
