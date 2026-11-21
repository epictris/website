"""Author full-detail assets in one scene; build a separate export scene."""
import json
from pathlib import Path
import subprocess
import tempfile

import bpy
from bpy.props import EnumProperty, FloatProperty, StringProperty
from bpy_extras.io_utils import ExportHelper, ImportHelper
from mathutils import Matrix

from . import core
from .asset_export import AXES, KEYS, MODES, settings, triangles


def selected_master(context):
    ob = context.active_object
    if ob is None or not ob.select_get(): return None
    return core.formation_of(ob) or (ob if ob.type == 'MESH' else None)


def draw_settings(layout, ob):
    layout.prop(ob, 'formation_representation')
    config = settings(ob)
    count = triangles(ob.data)
    if config['mode'] == 'REDUCED':
        layout.prop(ob, 'formation_keep_ratio', slider=True)
        layout.label(text=f'{count:,} master triangles; target about {max(1, int(count*config["ratio"])):,}')
    else:
        layout.label(text=f'{count:,} master triangles' if config['mode'] == 'FULL' else '2 export triangles')
    if config['mode'] != 'FULL': layout.prop(ob, 'formation_texture_resolution')
    if config['mode'] == 'SURFACE':
        layout.prop(ob, 'formation_surface_axis')
        layout.label(text='Direction is relative to the master')
    layout.label(text='Applied only in the generated export file')


class FORMATIONS_OT_mark_asset(bpy.types.Operator):
    """Make this full-detail model available in Blender's native Asset Browser"""
    bl_idname = 'formations.mark_asset'
    bl_label = 'Mark as Formation Asset'
    bl_options = {'REGISTER', 'UNDO'}

    @classmethod
    def poll(cls, context):
        ob = selected_master(context)
        return ob is not None and ob.is_editable

    def execute(self, context):
        ob = selected_master(context)
        ob['formation_asset'] = True
        ob.asset_mark()
        ob.asset_data.description = 'Full-detail formation master; export representation is selected in the Formations panel.'
        if not bpy.app.background: ob.asset_generate_preview()
        self.report({'INFO'}, 'Asset marked; save this authoring file to make it available in an asset library')
        return {'FINISHED'}


# Enum strings must remain alive for Blender's dynamic enum UI.
_library_items = []
_library_key = None


def library_objects(self, context):
    global _library_items, _library_key
    try:
        path = Path(bpy.path.abspath(self.filepath))
        key = (str(path), path.stat().st_mtime_ns)
        if key == _library_key:
            return _library_items
        with bpy.data.libraries.load(str(path), link=False) as (src, _):
            names = [n for n in src.objects if not n.endswith((' / guide', ' / placement'))]
        _library_items = [(n, n, '') for n in sorted(names)]
        _library_key = key
    except (OSError, RuntimeError):
        _library_items = []
        _library_key = None
    return _library_items


class FORMATIONS_OT_add_asset(bpy.types.Operator, ImportHelper):
    """Choose a master from a .blend file containing one or many assets"""
    bl_idname = 'formations.add_asset'
    bl_label = 'Add Formation'
    bl_options = {'REGISTER', 'UNDO'}
    filename_ext = '.blend'
    filter_glob: StringProperty(default='*.blend', options={'HIDDEN'})

    def execute(self, context):
        try:
            bpy.ops.formations.choose_asset('INVOKE_DEFAULT', filepath=self.filepath)
            return {'FINISHED'}
        except RuntimeError as error:
            self.report({'ERROR'}, str(error)); return {'CANCELLED'}


class FORMATIONS_OT_choose_asset(bpy.types.Operator):
    bl_idname = 'formations.choose_asset'
    bl_label = 'Choose Formation Master'
    bl_options = {'REGISTER', 'UNDO'}
    filepath: StringProperty(subtype='FILE_PATH')
    object_name: EnumProperty(name='Model', items=library_objects)

    def invoke(self, context, event):
        items = library_objects(self, context)
        if not items:
            self.report({'ERROR'}, 'This file has no models'); return {'CANCELLED'}
        self.object_name = items[0][0]
        return context.window_manager.invoke_props_dialog(self, width=420)

    def draw(self, context):
        self.layout.prop(self, 'object_name')
        self.layout.label(text='Imports the full-detail master at the 3D cursor')
        self.layout.label(text='Choose export detail after placing it')

    def execute(self, context):
        before = core.datablocks()
        try:
            filepath = Path(bpy.path.abspath(self.filepath)).resolve()
            with bpy.data.libraries.load(str(filepath), link=False) as (src, dst):
                if self.object_name not in src.objects: raise ValueError('Model is no longer in the library')
                dst.objects = [self.object_name]
            ob = dst.objects[0]
            if ob.type != 'MESH': raise ValueError('Choose a mesh model from the library')
            world = core.authored_world(ob)
            ob.parent = None; ob.matrix_parent_inverse = Matrix.Identity(4)
            ob.matrix_world = world; ob.location = context.scene.cursor.location
            # Imported masters are geometry assets. Their library guide and
            # recipe are not regenerated or resolved against same-named river guides.
            recipe = ob.get('formation_recipe')
            for key in list(ob.keys()):
                if key.startswith('formation_'): del ob[key]
            if recipe: ob['formation_source_recipe'] = recipe
            ob['formation_asset'] = True
            ob['formation_asset_source'] = str(filepath)
            core.collection(core.FORMATIONS).objects.link(ob)
            for item in context.selected_objects: item.select_set(False)
            ob.select_set(True); context.view_layer.objects.active = ob
            return {'FINISHED'}
        except (OSError, RuntimeError, ValueError) as error:
            imported = core.datablocks()-before
            if imported: bpy.data.batch_remove(ids=imported)
            self.report({'ERROR'}, str(error)); return {'CANCELLED'}


class FORMATIONS_OT_build_export(bpy.types.Operator, ExportHelper):
    """Build a disposable level file from the current full-detail authoring scene"""
    bl_idname = 'formations.build_export'
    bl_label = 'Build Export Scene'
    filename_ext = '.blend'
    filter_glob: StringProperty(default='*.blend', options={'HIDDEN'})

    @classmethod
    def poll(cls, context): return not core.busy() and not context.scene.get('formation_export_build')

    def invoke(self, context, event):
        path = Path(bpy.data.filepath) if bpy.data.filepath else Path.home()/'level.blend'
        self.filepath = str(path.with_name(path.stem+'-export.blend'))
        return ExportHelper.invoke(self, context, event)

    def execute(self, context):
        self._temp = None; self._proc = None; self._log = None
        self._cancelled = False
        try:
            output = Path(bpy.path.abspath(self.filepath)).resolve()
            if bpy.data.filepath and output == Path(bpy.data.filepath).resolve():
                raise ValueError('Choose a different file: the export must not overwrite its authoring file')
            if context.scene.get('formation_export_build'):
                raise ValueError('Open the authoring file to build another export')
            if context.mode != 'OBJECT': raise ValueError('Return to Object Mode before building the export scene')
            if output.suffix.lower() != '.blend':
                raise ValueError('The export filename must end in .blend')
            for library in bpy.data.libraries:
                if Path(bpy.path.abspath(library.filepath)).resolve() == output:
                    raise ValueError('The export must not overwrite a linked asset library')
            output.parent.mkdir(parents=True, exist_ok=True)
            # Large masters should use the destination disk, not a RAM-backed /tmp.
            self._temp = tempfile.TemporaryDirectory(prefix='.formation-export-', dir=output.parent)
            work = Path(self._temp.name)
            snapshot = work/'authoring.blend'
            bpy.ops.wm.save_as_mainfile(filepath=str(snapshot), copy=True, relative_remap=True)
            request = dict(output=str(output), cache=str(output.parent/'.formation-cache'),
                           scene=context.scene.name, source=bpy.data.filepath)
            (work/'request.json').write_text(json.dumps(request))
            self._log = (work/'build.log').open('w')
            self._proc = subprocess.Popen([bpy.app.binary_path, '-b', '--factory-startup', '--disable-autoexec',
                '-t', '2', str(snapshot), '--python-exit-code', '1', '--python',
                str(Path(__file__).with_name('asset_worker.py')), '--', str(work/'request.json')],
                stdout=self._log, stderr=subprocess.STDOUT)
            self._work, self._output = work, output
            core.rebuild_progress = 'Building export scene; Esc cancels'
            self._timer = context.window_manager.event_timer_add(.5, window=context.window)
            context.window_manager.modal_handler_add(self)
            self.report({'INFO'}, 'Building a separate export file; the authoring scene stays editable')
            return {'RUNNING_MODAL'}
        except (OSError, RuntimeError, ValueError) as error:
            if self._proc and self._proc.poll() is None:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._proc.kill()
                    self._proc.wait(timeout=5)
            self._finish(context)
            self.report({'ERROR'}, str(error)); return {'CANCELLED'}

    def _finish(self, context):
        if self._log: self._log.close(); self._log = None
        if getattr(self, '_timer', None):
            context.window_manager.event_timer_remove(self._timer); self._timer = None
        core.rebuild_progress = None
        if self._temp: self._temp.cleanup(); self._temp = None
        from .ops import redraw
        redraw(context)

    def modal(self, context, event):
        if event.type == 'ESC' and self._proc.poll() is None:
            self._proc.terminate()
            self._cancelled = True
            return {'RUNNING_MODAL'}
        if event.type != 'TIMER' or self._proc.poll() is None: return {'PASS_THROUGH'}
        if getattr(self, '_cancelled', False):
            self._finish(context); self.report({'INFO'}, 'Export build cancelled'); return {'CANCELLED'}
        if self._proc.returncode:
            self._log.flush()
            detail = (self._work/'build.log').read_text(errors='replace')
            from .ops import build_failed
            error = core.WorkerFailed('Export scene build failed', 'asset_worker.py', detail)
            build_failed(self, error, self._work)
            # Keep a durable failure log after the temporary snapshot is removed.
            try:
                self._output.with_suffix('.build-error.log').write_text(detail)
            finally:
                self._finish(context)
            return {'CANCELLED'}
        self._finish(context)
        self.report({'INFO'}, f'Export scene ready: {self._output}')
        return {'FINISHED'}


class FORMATIONS_PT_asset_export(bpy.types.Panel):
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Formations'
    bl_parent_id = 'FORMATIONS_PT_main'
    bl_label = 'Export Representation'

    @classmethod
    def poll(cls, context):
        ob = selected_master(context)
        return (ob is not None and not ob.get('formation_outline_owner')
                and not context.scene.get('formation_export_build'))

    def draw(self, context):
        ob = selected_master(context)
        layout = self.layout
        if not ob.is_editable:
            layout.label(text="Use a library override to edit linked settings")
        controls = layout.column()
        controls.enabled = not core.busy() and ob.is_editable
        draw_settings(controls, ob)
        layout.operator('formations.mark_asset', icon='ASSET_MANAGER')


def register():
    O = bpy.types.Object
    ids = [item[0] for item in MODES]
    O.formation_representation = EnumProperty(name='Representation', items=MODES,
        get=lambda ob: ids.index(ob.get(KEYS[0], 'FULL')),
        set=lambda ob, val: ob.__setitem__(KEYS[0], ids[val]))
    O.formation_keep_ratio = FloatProperty(name='Geometry to keep', min=.001, max=1., subtype='FACTOR',
        get=lambda ob: float(ob.get(KEYS[1], .25)), set=lambda ob,val: ob.__setitem__(KEYS[1], val))
    resolutions = ['128','256','512','1024','2048','4096']
    O.formation_texture_resolution = EnumProperty(name='Texture size', items=[(r,r+' px','') for r in resolutions],
        get=lambda ob: resolutions.index(str(ob.get(KEYS[2],1024))),
        set=lambda ob,val: ob.__setitem__(KEYS[2],int(resolutions[val])))
    axes = [item[0] for item in AXES]
    O.formation_surface_axis = EnumProperty(name='Wall faces', items=AXES,
        get=lambda ob: axes.index(ob.get(KEYS[3],'NEG_Y')), set=lambda ob,val: ob.__setitem__(KEYS[3],axes[val]))


def unregister():
    for name in ('formation_representation','formation_keep_ratio','formation_texture_resolution','formation_surface_axis'):
        delattr(bpy.types.Object, name)


OPERATORS = (FORMATIONS_OT_mark_asset, FORMATIONS_OT_add_asset, FORMATIONS_OT_choose_asset, FORMATIONS_OT_build_export)
PANELS = (FORMATIONS_PT_asset_export,)
