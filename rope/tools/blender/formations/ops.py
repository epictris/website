"""The Formations panel's operators."""

from __future__ import annotations

import bpy
from mathutils import Matrix
from bpy.props import EnumProperty, PointerProperty, StringProperty

from . import core, growth, params, slate


def redraw(context):
    for window in context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()


def selected_formations(context):
    """Selected formations, or the formations whose placement or growth is
    selected."""
    found = []
    for ob in context.selected_objects:
        if core.is_formation(ob):
            found.append(ob)
        elif ob.get("formation_root") or ob.get("formation_growth_owner"):
            rid = ob.get("formation_root") or ob.get("formation_growth_owner")
            found += [r for r in core.formations() if r["formation_id"] == rid]
    return list(dict.fromkeys(found))


def active_formation(context):
    ob = core.formation_of(context.active_object)
    if ob is None:
        found = selected_formations(context)
        ob = found[0] if len(found) == 1 else None
    if ob is None:
        raise ValueError("Select a formation")
    return ob


def guide_of_mesh(ob):
    """The guide a new solid formation takes from a selected closed mesh, in
    world space (the rock stands at the world origin: its stones are sized by
    their depth from the game's eye)."""
    if not ob or ob.type != "MESH" or core.is_formation(ob):
        raise ValueError("Select a closed mesh that is not a formation")
    if core.is_reference(ob):
        raise ValueError(ob.name + " is linked from another file, a reference only; model a mesh of your own")
    world = core.authored_world(ob)
    return {"verts": [[round(c, 6) for c in world @ v.co] for v in ob.data.vertices],
            "faces": [list(p.vertices) for p in ob.data.polygons]}


def outline_of_curve(ob):
    """The outline a new formation takes from a selected guide curve, in the
    guide's own plane (a curve is brought to the guides' convention first, in
    place: no point moves), and the frame its rock is placed in: where the
    guide stands, its plane the rock's X/Z. A reference (a collision outline
    among them) is refused: a rock is built from a guide. Another rock's guide
    is only read, never adopted: that rock keeps it."""
    if not ob or ob.type != "CURVE":
        raise ValueError("Select a guide curve")
    if core.is_reference(ob):
        raise ValueError(ob.name + " is linked from another file, a reference only; copy it into a guide of your own")
    return core.make_planar(ob), core.authored_world(ob) @ core.GUIDE_PLANE.inverted()


class FORMATIONS_OT_generate(bpy.types.Operator):
    """Build a formation's rock in a separate process; the scene stays editable.
    Regenerate and New Variant build from the parameters on the rock"""
    bl_idname = "formations.generate"
    bl_label = "Generate Formation"
    bl_options = {"REGISTER", "UNDO"}

    mode: EnumProperty(items=[("CREATE", "Create", ""), ("REBUILD", "Regenerate", ""), ("VARIANT", "New variant", "")])
    preset: EnumProperty(name="Starting outline",
                         items=[(x.upper(), x.title(), "") for x in ("terrace", "pillar", "wall", "arch", "distant")])
    settings: PointerProperty(type=params.FormationParams)
    # What a new rock is built from; the panel's buttons say, and AUTO (a
    # search or a script) takes the selected curve or mesh, else a preset.
    source: EnumProperty(items=[("AUTO", "Auto", "The selected curve or mesh, else a starting outline"),
                                ("PRESET", "Starting outline", "A preset outline at the 3D cursor"),
                                ("GUIDE", "Guide", "The selected guide (a closed poly curve)"),
                                ("MESH", "Mesh", "The selected closed mesh, as its guide (Solid guide)")],
                         options={"SKIP_SAVE"})

    @property
    def use_outline(self):
        return self.source == "GUIDE"

    @property
    def use_guide(self):
        return self.source == "MESH"

    def resolve_source(self, context):
        if self.source == "AUTO":
            ob = context.active_object
            selected = ob is not None and ob.select_get()
            self.source = ("GUIDE" if selected and ob.type == "CURVE" else
                           "MESH" if selected and ob.type == "MESH" and not core.is_formation(ob) else "PRESET")

    def invoke(self, context, event):
        if self.mode != "CREATE":
            return self.execute(context)
        self.resolve_source(context)
        # The dialog keeps its last fields: a mesh takes the solid
        # generator, and an outline cannot.
        if self.use_guide:
            self.settings.generator = "solid"
        elif self.settings.generator == "solid":
            self.settings.generator = "fitted"
        return context.window_manager.invoke_props_dialog(self, width=340, title={
            "PRESET": "New Formation", "GUIDE": "Build Formation from Guide",
            "MESH": "Build Formation from Mesh"}[self.source])

    def draw(self, context):
        col = self.layout.column()
        col.use_property_split = True
        col.use_property_decorate = False
        if self.source == "PRESET":
            col.prop(self, "preset")
        params.draw(col, self.settings, solid=self.use_guide)
        self.layout.label(text="Builds in a separate process; Esc discards the result.")

    def execute(self, context):
        try:
            if self.mode == "CREATE":
                self.resolve_source(context)
            from_selected = self.use_outline or self.use_guide
            self._target = None if self.mode == "CREATE" and not from_selected else (
                context.active_object if self.mode == "CREATE" else active_formation(context))
            if self.mode == "REBUILD":
                core.assert_rebuildable(self._target)
            if self.mode == "CREATE":
                params.validate(self.settings)
                if (self.settings.generator == "solid") != self.use_guide:
                    raise ValueError("A Solid guide formation is made from a selected closed mesh, and only it")
                recipe = {"preset": self.preset.lower()}
                recipe["generator"], recipe["params"] = params.from_settings(self.settings)
                if self.use_outline:
                    recipe["outline"], self._frame = outline_of_curve(self._target)
                    # A free guide becomes the rock's own; another rock's
                    # guide is only read.
                    self._adopt = core.is_free_guide(self._target)
                    self._target_name = self._target.name
                elif self.use_guide:
                    recipe["guide"] = guide_of_mesh(self._target)
                    recipe["camera"] = core.scene_camera(context.scene)
                    recipe["frame"] = [list(r) for r in Matrix.Identity(4)]
                    self._frame = Matrix.Identity(4)
                    self._target_name = self._target.name
            else:
                recipe = core.recipe_for(self._target)
                # Held by name: a reference to the object goes stale if it is
                # deleted, or undone over, while the rock builds.
                self._target_name = self._target.name
            self._request = recipe
            self._proc, self._out, self._log = core.launch_worker(recipe)
            self._timer = context.window_manager.event_timer_add(.5, window=context.window)
            context.window_manager.modal_handler_add(self)
            self.report({"INFO"}, "Generating; keep working. Esc discards the result.")
            return {"RUNNING_MODAL"}
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}

    def modal(self, context, event):
        if event.type == "ESC":
            self._log.close()
            context.window_manager.event_timer_remove(self._timer)
            self.report({"INFO"}, "Result discarded; the scene is unchanged")
            return {"CANCELLED"}
        if event.type != "TIMER" or self._proc.poll() is None:
            return {"PASS_THROUGH"}
        self._log.close()
        context.window_manager.event_timer_remove(self._timer)
        try:
            if self._proc.returncode:
                raise ValueError(core.worker_failure(self._out))
            if self.mode == "CREATE":
                name = {"fitted": "Fitted slate", "solid": getattr(self, "_target_name", "Solid")}.get(
                    self.settings.generator, self.preset.title())
                ob = core.append_rock(self._out / "rock.blend", name)
                if self.use_guide:
                    # The mesh is now the rock's guide (a copy of it, in the
                    # rock's frame): the original goes.
                    source = bpy.data.objects.get(self._target_name)
                    if source is not None and not core.is_formation(source):
                        data = source.data
                        bpy.data.objects.remove(source, do_unlink=True)
                        if data.users == 0:
                            bpy.data.meshes.remove(data)
                elif self._target is not None:
                    source = bpy.data.objects.get(self._target_name)
                    if self._adopt and core.is_free_guide(source):
                        core.adopt_guide(ob, source)
                    else:
                        ob.parent.matrix_world = self._frame
                else:
                    ob.parent.location = context.scene.cursor.location
            else:
                target = bpy.data.objects.get(self._target_name)
                if not core.is_formation(target):
                    raise ValueError("The formation was deleted; the result is in " + str(self._out))
                ob = core.replace_from_worker(target, self._out / "rock.blend", self.mode == "VARIANT")
                # The variant took the edited parameters; the rock it came
                # from is still the one its recipe built.
                asked = (self._request["generator"], self._request["params"])
                if self.mode == "VARIANT" and params.current(target) == asked:
                    params.load(target)
            bpy.ops.object.select_all(action="DESELECT")
            ob.select_set(True)
            context.view_layer.objects.active = ob
            self.report({"INFO"}, "Formation ready; replant its growth")
            return {"FINISHED"}
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}


class FORMATIONS_OT_rebuild_changed(bpy.types.Operator):
    """Rebuild every formation whose guide or parameters changed, one rock at
    a time; the meshes are swapped only once every rock has built and validated"""
    bl_idname = "formations.rebuild_changed"
    bl_label = "Rebuild Changed"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        try:
            if context.scene.get(core.BUSY):
                raise ValueError("A rebuild is already running")
            self._targets = [ob for ob in core.formations() if core.pending(ob)]
            for ob in self._targets:
                if not core.is_solid(ob):
                    core.validate_polygon(core.outline_points(ob))
                core.assert_rebuildable(ob)
            if not self._targets:
                self.report({"INFO"}, "No guide or parameters have changed")
                return {"FINISHED"}
            self._done, self._index, self._cancelled = [], 0, False
            self._launch(context)
            context.scene[core.BUSY] = True
            self._timer = context.window_manager.event_timer_add(.5, window=context.window)
            context.window_manager.modal_handler_add(self)
            self.report({"INFO"}, f"Rebuilding {len(self._targets)} formations; Esc discards the results")
            return {"RUNNING_MODAL"}
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}

    def _launch(self, context):
        ob = self._targets[self._index]
        self._request = core.recipe_for(ob)
        self._proc, self._out, self._log = core.launch_worker(self._request)
        context.scene[core.PROGRESS] = f"{self._index + 1}/{len(self._targets)}: {ob.name}"
        redraw(context)

    def _cleanup(self, context):
        context.window_manager.event_timer_remove(self._timer)
        context.scene[core.BUSY] = False
        context.scene[core.PROGRESS] = ""
        redraw(context)

    def modal(self, context, event):
        if event.type == "ESC":
            self._cancelled = True
        if event.type != "TIMER" or self._proc.poll() is None:
            return {"PASS_THROUGH"}
        self._log.close()
        try:
            if self._cancelled:
                self._cleanup(context)
                self.report({"INFO"}, "Rebuild cancelled; meshes kept")
                return {"CANCELLED"}
            if self._proc.returncode:
                raise ValueError(core.worker_failure(self._out))
            self._done.append((self._targets[self._index], self._out / "rock.blend", self._request))
            self._index += 1
            if self._index < len(self._targets):
                self._launch(context)
                return {"RUNNING_MODAL"}
            # Every result validates before any mesh is replaced.
            for ob, file, request in self._done:
                core.assert_rebuildable(ob)
                if core.recipe_for(ob) != request:
                    raise ValueError(ob.name + ": changed while it built; rebuild again")
                before = core.datablocks()
                try:
                    with bpy.data.libraries.load(str(file), link=False) as (_, dst):
                        dst.objects = ["SceneryRock"]
                        dst.collections = ["SOURCE_SLABS"]
                    core.validate_worker(dst.objects[0], dst.collections[0])
                finally:
                    imported = core.datablocks() - before
                    if imported:
                        bpy.data.batch_remove(ids=imported)
            for ob, file, _ in self._done:
                core.replace_from_worker(ob, file)
            self._cleanup(context)
            self.report({"INFO"}, f"Rebuilt {len(self._done)} formations; replant their growth")
            return {"FINISHED"}
        except ValueError as e:
            self._cleanup(context)
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}


class FORMATIONS_OT_action(bpy.types.Operator):
    """A formation action"""
    bl_idname = "formations.action"
    bl_label = "Formation Action"
    bl_options = {"REGISTER", "UNDO"}

    action: StringProperty()

    def execute(self, context):
        try:
            ob = active_formation(context)
            if self.action == "UNIQUE":
                core.make_unique(ob)
            elif self.action == "LOAD_PARAMS":
                params.load(ob)
            elif self.action == "RESET_RENDER":
                from . import render
                render.reset(ob)
            elif self.action == "MANUAL":
                ob["formation_mode"] = "MANUAL"
            elif self.action == "ASSEMBLE":
                core.assemble_sources(ob)
            elif self.action in ("OUTLINE", "ROCK"):
                # One or the other: the guide shown and selected with its rocks
                # hidden, or the rock with its guide hidden. Its rocks: a
                # duplicate shares the guide until Make Unique, and may stand
                # right on top of the one clicked. Viewport hiding only: the
                # export goes by render visibility and lifts it.
                guide = bpy.data.objects[ob["formation_outline"]]
                rocks = [r for r in core.formations() if r.get("formation_outline") == guide.name]
                if context.mode != "OBJECT":
                    bpy.ops.object.mode_set(mode="OBJECT")
                if self.action == "OUTLINE":
                    core.collection(core.RECIPES).hide_viewport = False
                    target = guide
                else:
                    target = ob
                for r in rocks:
                    r.hide_set(target is guide)
                target.hide_set(False)
                bpy.ops.object.select_all(action="DESELECT")
                target.select_set(True)
                context.view_layer.objects.active = target
                guide.hide_set(target is not guide)
            elif self.action == "SOURCES":
                core.collection(core.RECIPES).hide_viewport = False
                bpy.data.collections[ob["formation_sources"]].hide_viewport = False
            elif self.action == "HIDE_SOURCES":
                bpy.data.collections[ob["formation_sources"]].hide_viewport = True
            return {"FINISHED"}
        except (KeyError, ValueError) as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}


class FORMATIONS_OT_plant(bpy.types.Operator):
    """Replant moss beds, sprigs and hanging moss on formations"""
    bl_idname = "formations.plant"
    bl_label = "Replant Growth"
    bl_options = {"REGISTER", "UNDO"}

    scope: EnumProperty(items=[("SELECTED", "Selected", ""), ("STALE", "Stale", ""), ("ALL", "All", "")])

    def execute(self, context):
        try:
            rocks = {"SELECTED": selected_formations(context),
                     "STALE": [r for r in core.formations() if growth.stale(r)],
                     "ALL": core.formations()}[self.scope]
            pending = [r.name for r in rocks if core.pending(r)]
            if pending:
                raise ValueError("Rebuild changed formations first: " + ", ".join(pending))
            if not rocks:
                self.report({"INFO"}, "Nothing to replant")
                return {"FINISHED"}
            report = growth.plant(rocks, context.scene)
            self.report({"INFO"}, f"Replanted {len(report)} formations, {sum(report.values())} pieces")
            return {"FINISHED"}
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}


class FORMATIONS_OT_tone_facets(bpy.types.Operator):
    """Tone each face by its orientation, so faces pointing almost the same way share a colour, and shade the rocks flat"""
    bl_idname = "formations.tone_facets"
    bl_label = "Tone Facets"
    bl_options = {"REGISTER", "UNDO"}

    scope: EnumProperty(items=[("SELECTED", "Selected", ""), ("ALL", "All", "")])

    def execute(self, context):
        rocks = selected_formations(context) if self.scope == "SELECTED" else core.formations()
        if not rocks:
            self.report({"INFO"}, "No formations to tone")
            return {"FINISHED"}
        # A rock built since 2026-10-02 is toned by its build already; this
        # brings an older one to the same state, and moves no vertex, so growth
        # and rebuild state stay as they were.
        faces = sum(slate.tone_facets(ob, params.built(ob)[1]["seed"]) for ob in rocks)
        self.report({"INFO"}, f"Toned {len(rocks)} formations ({faces} faces)")
        return {"FINISHED"}


class FORMATIONS_OT_planar_transform(bpy.types.Operator):
    """Move, rotate or scale the selected points of a flat (2D) curve in its own plane, the cursor
    staying on the point: G, R and S in Edit Mode on a guide"""
    bl_idname = "formations.planar_transform"
    bl_label = "Transform in Plane"

    mode: EnumProperty(items=[("TRANSLATE", "Move", ""), ("ROTATE", "Rotate", ""), ("RESIZE", "Scale", "")])

    @classmethod
    def poll(cls, context):
        # Any other curve falls through to Blender's own G, R and S.
        ob = context.edit_object
        return context.mode == "EDIT_CURVE" and ob is not None and ob.data.dimensions == "2D"

    def invoke(self, context, event):
        # Blender keeps a 2D curve's points on its plane whatever moves them,
        # but an unconstrained move follows the cursor across the VIEW plane
        # and is then flattened, so in any view not square to the guide the
        # point drifts from under the cursor. Constrained to the curve's own
        # (local) plane, the move puts it where the cursor's ray meets that
        # plane; X, Y or Z during the move still constrain as usual.
        if self.mode == "TRANSLATE":
            bpy.ops.transform.translate("INVOKE_DEFAULT", orient_type="LOCAL", constraint_axis=(True, True, False))
        elif self.mode == "ROTATE":
            bpy.ops.transform.rotate("INVOKE_DEFAULT", orient_type="LOCAL", constraint_axis=(False, False, True))
        else:
            bpy.ops.transform.resize("INVOKE_DEFAULT", orient_type="LOCAL", constraint_axis=(True, True, False))
        return {"FINISHED"}


# G, R and S in curve Edit Mode, in front of Blender's own (which take every
# curve the operator's poll refuses).
KEYS = (("G", "TRANSLATE"), ("R", "ROTATE"), ("S", "RESIZE"))
keymap_items = []


def register_keys():
    keyconfig = bpy.context.window_manager.keyconfigs.addon
    if keyconfig is None:
        # Blender in the background has no key configurations.
        return
    keymap = keyconfig.keymaps.new(name="Curve", space_type="EMPTY")
    for key, mode in KEYS:
        item = keymap.keymap_items.new(FORMATIONS_OT_planar_transform.bl_idname, key, "PRESS")
        item.properties.mode = mode
        keymap_items.append((keymap, item))


def unregister_keys():
    for keymap, item in keymap_items:
        keymap.keymap_items.remove(item)
    keymap_items.clear()


class FORMATIONS_OT_repaint_slate(bpy.types.Operator):
    """Rebuild every painted slate material in this file to the add-on's current shader, in place; no rock is rebuilt"""
    bl_idname = "formations.repaint_slate"
    bl_label = "Repaint Slate"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        # A rock's stone comes in with its build; a file built before the
        # shader changed keeps the old graph until it is repainted.
        count = slate.repaint()
        if not count:
            self.report({"INFO"}, "No painted slate in this file")
            return {"FINISHED"}
        self.report({"INFO"}, f"Repainted {count} materials")
        return {"FINISHED"}


CLASSES = (FORMATIONS_OT_generate, FORMATIONS_OT_rebuild_changed, FORMATIONS_OT_action, FORMATIONS_OT_plant,
           FORMATIONS_OT_tone_facets, FORMATIONS_OT_planar_transform, FORMATIONS_OT_repaint_slate)
