"""The moss brush: the shared stamp brush (stampbrush/brush.py, also the ivy's)
laying stamps on one moss object, the selected one. Left-drag paints, Ctrl+left-
drag erases, [ and ] resize, Escape (or right-click, or Enter) ends; Erase Moss
is the same brush the other way round. With no moss selected, or from New Moss,
the first stroke creates a moss with the settings of the moss the panel showed
when painting began. The paint joins every rock it reaches to the moss, which
grows over them as one."""

import bpy

from . import ops
from .stampbrush.brush import StampBrush


class MOSS_OT_paint(StampBrush, bpy.types.Operator):
    bl_idname = "moss.paint"
    bl_label = "Paint Moss"
    bl_description = "Paint moss onto meshes in the viewport: drag to paint, Ctrl+drag to erase, [ ] radius, Esc to finish"
    bl_options = {"REGISTER", "UNDO"}

    LABEL = "Moss"
    GROW_WHILE_PAINTING = False  # builds take seconds: the paint is previewed, the moss grows on Esc
    COLOR = (0.55, 0.85, 0.3, 0.9)

    def brush(self, context):
        return context.scene.moss_brush

    def active(self, context):
        return ops.active_moss(context)

    def hosts_of(self, ob):
        return ops.hosts_of(ob)

    def join(self, ob, host):
        ops.join(ob, host)

    def create(self, host, scene, template):
        return ops.create_moss(host, scene, template)

    def stamps_mesh(self, ob):
        return ob.moss.stamps

    def host_of(self, ob):
        return bpy.data.objects.get(ob.moss.host)

    def rebuild(self, ob):
        ops.rebuild(ob)

    def build_ms(self, ob):
        return ob.moss.build_ms

    def coverage_threshold(self, ob):
        return ob.moss.threshold


CLASSES = (MOSS_OT_paint,)
