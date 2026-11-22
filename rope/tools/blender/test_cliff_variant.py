"""Named solid variants: legacy recipes, UI changes and worker round trips."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import bpy
import formations
from formations import core, params, worker

bpy.ops.wm.read_factory_settings(use_empty=True)
formations.register()
bpy.ops.mesh.primitive_cube_add()
rock = bpy.context.object
guide = bpy.data.objects.new('Variant test guide', rock.data.copy())
bpy.context.scene.collection.objects.link(guide)
rock['formation_outline'] = guide.name
geometry = {'verts': [list(v.co) for v in guide.data.vertices],
            'faces': [list(p.vertices) for p in guide.data.polygons]}
settings = dict(worker.GENERATORS['solid'], seed=31, stoneSize=.75,
                surfaceRelief=.8, jointAspect=3.2, knub=.08)
recipe = {'version': 2, 'generator': 'solid', 'guide': geometry, 'params': settings}
rock['formation_recipe'] = json.dumps(recipe)
params.load(rock)
assert rock.formation_params.variant == 'cliff'
assert not core.pending(rock)
before = core.mesh_hash(rock.data)
rock.formation_params.variant = 'boulder'
assert params.changed(rock) and core.pending(rock)
asked = core.recipe_for(rock)
assert asked['variant'] == 'boulder' and asked['params']['jointed'] is False
assert asked['params']['seed'] == 31 and asked['params']['stoneSize'] == .75
rock.formation_params.variant = 'cliff'
assert not params.changed(rock) and not core.pending(rock)
assert core.recipe_for(rock)['variant'] == 'cliff'
assert core.mesh_hash(rock.data) == before
rock.formation_params.variant = 'wall'
assert params.changed(rock) and core.pending(rock)
asked = core.recipe_for(rock)
assert asked['variant'] == 'wall' and asked['params']['wall'] and not asked['params']['jointed']
assert core.mesh_hash(rock.data) == before

with tempfile.TemporaryDirectory(prefix='cliff-variant-test-') as folder:
    folder = Path(folder)
    for jointed, expected in ((True, 'cliff'), (False, 'boulder')):
        legacy = dict(recipe, params=dict(settings, jointed=jointed))
        worker.prepare(legacy, folder)
        built = json.loads((folder/'recipe.json').read_text())
        assert built['variant'] == expected
        assert built['params'] == legacy['params']
        rock['formation_recipe'] = json.dumps(legacy)
        params.load(rock)
        assert rock.formation_params.variant == expected
        assert not params.changed(rock)
    # The explicit name is canonical even if a legacy flag disagrees.
    named = dict(recipe, variant='cliff', params=dict(settings, jointed=False))
    worker.prepare(named, folder)
    assert json.loads((folder/'recipe.json').read_text())['params']['jointed'] is True
    rock['formation_recipe'] = json.dumps(named)
    params.load(rock)
    assert rock.formation_params.variant == 'cliff' and not params.changed(rock)
    named = dict(recipe, variant='wall', params=dict(settings, jointed=True, wall=False))
    worker.prepare(named, folder)
    built = json.loads((folder/'recipe.json').read_text())
    assert built['variant'] == 'wall' and built['params']['wall'] and not built['params']['jointed']
    rock['formation_recipe'] = json.dumps(built)
    params.load(rock)
    assert rock.formation_params.variant == 'wall' and not params.changed(rock)
    rock.formation_params.variant = 'cliff'
    assert core.recipe_for(rock)['variant'] == 'cliff' and not rock.formation_params.wall
    try:
        worker.prepare(dict(recipe, variant='unknown'), folder)
    except ValueError:
        pass
    else:
        raise AssertionError('Unknown variant was silently accepted')
print('SOLID_VARIANTS_OK: Boulder/Cliff/Wall UI, legacy compatibility, named recipes, unchanged geometry', flush=True)
