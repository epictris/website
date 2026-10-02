"""The moss brush: the shared stamp brush (stampbrush/brush.py, also the ivy's)
laying stamps on a rock's moss object. Left-drag paints, Ctrl+left-drag erases,
[ and ] resize, Escape (or right-click, or Enter) ends; Erase Moss is the same
brush the other way round. The first stroke on a rock creates its moss object
with the settings of the moss the panel showed when painting began."""

import bpy

from . import ops
from .stampbrush.brush import StampBrush


class MOSS_OT_paint(StampBrush, bpy.types.Operator):
    bl_idname = "moss.paint"
    bl_label = "Paint Moss"
    bl_description = "Paint moss onto meshes in the viewport: drag to paint, Ctrl+drag to erase, [ ] radius, Esc to finish"
    bl_options = {"REGISTER", "UNDO"}

    LABEL = "Moss"
    COLOR = (0.55, 0.85, 0.3, 0.9)

    def brush(self, context):
        return context.scene.moss_brush

    def active(self, context):
        return ops.active_moss(context)

    def grown_for(self, host):
        return ops.moss_for_host(host)

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


CLASSES = (MOSS_OT_paint,)
