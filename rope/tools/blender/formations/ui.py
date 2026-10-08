"""The Formations tab in the 3D viewport's sidebar (N).

It shows what the clicked object offers and little else: a formation (its
rock, placement, guide, growth or a source slab) gets its own panel and
sub-panels, a free guide or a mesh gets the button that builds a rock from
it, and with nothing selected there is only New Formation. What concerns the
whole scene is in the Scene sub-panel, closed until opened."""

import bpy

from . import core, params, render

LABELS = {"fitted": "Fitted slate", "boulders": "Boulders", "solid": "Solid guide"}
SHORT = {"formation_export_chips": "Chips", "formation_export_texels": "Texels per m"}


def selected_active(context):
    """The active object when it is selected: a deselected active object
    (after Alt+A) is not something clicked."""
    ob = context.active_object
    return ob if ob is not None and ob.select_get() else None


def active_formation(context):
    return core.formation_of(selected_active(context))


def mesh_source(ob):
    """Whether `ob` could become a Solid guide formation's guide: a mesh of
    the scene's own that is no part of a formation or of something grown on
    a rock."""
    return (ob is not None and ob.type == "MESH" and ob.parent is None and not core.is_reference(ob)
            and "formation_recipe" not in ob and core.formation_of(ob) is None)


def is_pending(ob):
    """`core.pending`, where a guide that cannot be read (mid-edit, or a
    solid rock in a scene without its start camera) counts as changed: the
    rebuild says what is wrong with it."""
    try:
        return core.pending(ob)
    except (KeyError, ValueError):
        return True


def is_duplicate(ob):
    """Whether `ob` shares its mesh, or its id, with another formation."""
    return ob.data.users > 1 or sum(r["formation_id"] == ob["formation_id"] for r in core.formations()) > 1


def sources_shown(ob):
    slabs = bpy.data.collections.get(ob.get("formation_sources", ""))
    recipes = bpy.data.collections.get(core.RECIPES)
    return slabs is not None and not slabs.hide_viewport and recipes is not None and not recipes.hide_viewport


class FORMATIONS_PT_main(bpy.types.Panel):
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Formations"
    bl_label = "Formations"

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        layout.enabled = not scene.get(core.BUSY, False)
        if scene.get(core.BUSY):
            layout.label(text=scene.get(core.PROGRESS, "Working..."), icon="TIME")
        active = selected_active(context)
        ob = core.formation_of(active)
        if ob is not None:
            self.draw_formation(layout, ob, active)
        elif core.is_free_guide(active):
            layout.label(text=active.name, icon="CURVE_DATA")
            op = layout.operator("formations.generate", text="Build Formation from Guide", icon="ADD")
            op.mode, op.source = "CREATE", "GUIDE"
        elif mesh_source(active):
            layout.label(text=active.name, icon="MESH_DATA")
            op = layout.operator("formations.generate", text="Build Formation from Mesh", icon="ADD")
            op.mode, op.source = "CREATE", "MESH"
            layout.label(text="A closed mesh becomes its guide")
        else:
            layout.label(text="Click a formation or a guide")
            op = layout.operator("formations.generate", text="New Formation", icon="ADD")
            op.mode, op.source = "CREATE", "PRESET"
        # Scene-wide, but only while something waits for it.
        pending = sum(is_pending(r) for r in core.formations())
        if pending:
            layout.operator("formations.rebuild_changed", text=f"Rebuild Changed ({pending})", icon="FILE_REFRESH")

    @staticmethod
    def draw_formation(layout, ob, active):
        manual = ob.get("formation_mode") == "MANUAL"
        kind = LABELS.get(params.built(ob)[0], "")
        layout.label(text=f"{ob.name}: {kind}" + (", manual mesh" if manual else ""), icon="MESH_ICOSPHERE")
        pending = is_pending(ob)
        if pending and not manual:
            layout.label(text="Guide or parameters changed", icon="INFO")
        row = layout.row(align=True)
        if not manual:
            # A manual mesh is never rebuilt over; a variant is its way on.
            regenerate = row.row(align=True)
            regenerate.alert = pending
            regenerate.operator("formations.generate", text="Regenerate", icon="FILE_REFRESH").mode = "REBUILD"
        row.operator("formations.generate", text="New Variant").mode = "VARIANT"
        if active is ob:
            layout.operator("formations.action", text="View Guide", icon="HIDE_OFF").action = "OUTLINE"
        else:
            layout.operator("formations.action", text="View Formation", icon="HIDE_OFF").action = "ROCK"


class FormationSubpanel:
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Formations"
    bl_parent_id = "FORMATIONS_PT_main"

    @classmethod
    def poll(cls, context):
        return active_formation(context) is not None


class FORMATIONS_PT_generator(FormationSubpanel, bpy.types.Panel):
    bl_label = "Generator"

    def draw(self, context):
        ob = active_formation(context)
        layout = self.layout
        layout.enabled = not context.scene.get(core.BUSY, False)
        settings = params.editable(ob)
        if settings is None:
            layout.operator("formations.action", text="Edit Parameters").action = "LOAD_PARAMS"
            return
        params.draw(layout, settings, solid=core.is_solid(ob))
        if params.changed(ob):
            layout.operator("formations.action", text="Revert to Built", icon="LOOP_BACK").action = "LOAD_PARAMS"


class FORMATIONS_PT_growth(FormationSubpanel, bpy.types.Panel):
    bl_label = "Growth"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        ob = active_formation(context)
        layout = self.layout
        layout.enabled = not context.scene.get(core.BUSY, False)
        col = layout.column()
        col.use_property_split = True
        col.use_property_decorate = False
        col.prop(ob, "formation_attachment")
        col.prop(ob, "formation_moisture")
        layout.operator("formations.plant", text="Replant").scope = "SELECTED"


class FORMATIONS_PT_render(FormationSubpanel, bpy.types.Panel):
    bl_label = "Render (export)"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        ob = active_formation(context)
        layout = self.layout
        layout.enabled = not context.scene.get(core.BUSY, False)
        col = layout.column()
        col.use_property_split = True
        col.use_property_decorate = False
        for field in render.FIELDS.values():
            # Two names are cut short at the sidebar's width; render.py keeps
            # them whole (it is in the bake cache's key: docs/blender-scenes.md).
            if field in SHORT:
                col.prop(ob, field, text=SHORT[field])
            else:
                col.prop(ob, field)
        if render.explicit(ob):
            layout.operator("formations.action", text="Passes and Maps From Depth").action = "RESET_RENDER"


class FORMATIONS_PT_mesh(FormationSubpanel, bpy.types.Panel):
    bl_label = "Mesh"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        ob = active_formation(context)
        layout = self.layout
        layout.enabled = not context.scene.get(core.BUSY, False)
        col = layout.column(align=True)
        if is_duplicate(ob):
            col.operator("formations.action", text="Make Unique").action = "UNIQUE"
        if ob.get("formation_mode") != "MANUAL":
            col.operator("formations.action", text="Keep As Manual Mesh").action = "MANUAL"
        if ob.get("formation_sources") in bpy.data.collections:
            if sources_shown(ob):
                col.operator("formations.action", text="Hide Source Slabs").action = "HIDE_SOURCES"
                col.operator("formations.action", text="Assemble Edited Slabs").action = "ASSEMBLE"
            else:
                col.operator("formations.action", text="Show Source Slabs").action = "SOURCES"
        col.operator("formations.tone_facets", text="Tone Facets").scope = "SELECTED"


class FORMATIONS_PT_scene(bpy.types.Panel):
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Formations"
    bl_parent_id = "FORMATIONS_PT_main"
    bl_label = "Scene"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        layout = self.layout
        layout.enabled = not context.scene.get(core.BUSY, False)
        scene = context.scene
        layout.prop(scene, "formations_show_guides")
        layout.prop(scene, "formations_rocks_wire")
        # Stale is decided by hashing each mesh, too slow for every redraw;
        # the export reports it, and Stale replants exactly those.
        layout.label(text="Replant growth")
        row = layout.row(align=True)
        row.operator("formations.plant", text="Stale").scope = "STALE"
        row.operator("formations.plant", text="All").scope = "ALL"
        layout.label(text="Painted slate")
        row = layout.row(align=True)
        row.operator("formations.tone_facets", text="Tone All Facets").scope = "ALL"
        row.operator("formations.repaint_slate", text="Repaint")


CLASSES = (FORMATIONS_PT_main, FORMATIONS_PT_generator, FORMATIONS_PT_growth, FORMATIONS_PT_render,
           FORMATIONS_PT_mesh, FORMATIONS_PT_scene)
