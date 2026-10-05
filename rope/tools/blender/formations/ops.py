"""The Formations panel's operators."""

from __future__ import annotations

import math

import bpy
from mathutils import Matrix
from bpy.props import BoolProperty, EnumProperty, FloatProperty, PointerProperty, StringProperty

from . import core, growth, params, slate, view


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


class FORMATIONS_OT_look(bpy.types.Operator):
    """Make the game camera the scene camera and look through it from the start of its route"""
    bl_idname = "formations.look"
    bl_label = "Look Through Game Camera"

    def execute(self, context):
        try:
            cam = view.look_from_start(context)
            self.report({"INFO"}, f"Game camera: {cam.get('game_source', '')}")
            return {"FINISHED"}
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}


class FORMATIONS_OT_ride(bpy.types.Operator):
    """Move the game camera along its route at the game's pace, or pause it"""
    bl_idname = "formations.ride"
    bl_label = "Ride Game Camera"

    direction: EnumProperty(items=[("BACK", "Back", "Back along the route"), ("PAUSE", "Pause", "Hold the camera"),
                                   ("FORWARD", "Forward", "Forward along the route")])

    @classmethod
    def description(cls, context, properties):
        return {"BACK": "Ride the game camera back along its route", "PAUSE": "Pause the game camera",
                "FORWARD": "Ride the game camera forward along its route"}[properties.direction]

    def execute(self, context):
        view.ride(context, {"BACK": -1, "PAUSE": 0, "FORWARD": 1}[self.direction])
        return {"FINISHED"}


def guide_of_mesh(ob):
    """The guide a new solid formation takes from a selected closed mesh, in
    world space (the rock stands at the world origin: its stones are sized by
    their depth from the game's eye)."""
    if not ob or ob.type != "MESH" or core.is_formation(ob):
        raise ValueError("Select a closed mesh that is not a formation")
    world = core.authored_world(ob)
    return {"verts": [[round(c, 6) for c in world @ v.co] for v in ob.data.vertices],
            "faces": [list(p.vertices) for p in ob.data.polygons]}


def outline_of_curve(ob):
    """The outline a new formation takes from a selected curve, and the frame
    its rock is placed in. A 3D curve keeps its outline in its local X/Z plane,
    as a formation's own outline does; a flat (2D) curve - a scene guide's
    collision piece - keeps it in its local X/Y, so the rock is turned a quarter
    about X to stand on it, its front where the curve faces."""
    if not ob or ob.type != "CURVE" or len(ob.data.splines) != 1:
        raise ValueError("Select a curve with a single outline (a guide piece with a hole will not do)")
    sp = ob.data.splines[0]
    if sp.type != "POLY" or not sp.use_cyclic_u:
        raise ValueError("Use a closed POLY curve")
    if ob.data.dimensions == "2D":
        return [[p.co.x, p.co.y] for p in sp.points], ob.matrix_world @ Matrix.Rotation(-math.pi / 2, 4, "X")
    if any(abs(p.co.y) > .001 for p in sp.points):
        raise ValueError("Use a flat curve, or a 3D curve in its local X/Z plane")
    return [[p.co.x, p.co.z] for p in sp.points], ob.matrix_world.copy()


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
    use_outline: BoolProperty(name="From the selected outline (a curve or guide piece)", default=False)
    use_guide: BoolProperty(name="From the selected mesh, as its guide (Solid guide)", default=False)

    def invoke(self, context, event):
        if self.mode != "CREATE":
            return self.execute(context)
        ob = context.active_object
        self.use_outline = bool(ob and ob.type == "CURVE" and ob.select_get())
        self.use_guide = bool(ob and ob.type == "MESH" and ob.select_get() and not core.is_formation(ob))
        if self.use_guide:
            self.settings.generator = "solid"
        return context.window_manager.invoke_props_dialog(self, width=340)

    def draw(self, context):
        col = self.layout.column()
        col.use_property_split = True
        col.use_property_decorate = False
        if not self.use_outline and not self.use_guide:
            col.prop(self, "preset")
        params.draw(col, self.settings)
        self.layout.prop(self, "use_outline")
        self.layout.prop(self, "use_guide")
        self.layout.label(text="Builds in a separate process; Esc discards the result.")

    def execute(self, context):
        try:
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
    """Rebuild every formation whose outline or parameters changed, one rock at
    a time; the meshes are swapped only once every rock has built and validated"""
    bl_idname = "formations.rebuild_changed"
    bl_label = "Rebuild Changed"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        try:
            if context.scene.get("formations_busy"):
                raise ValueError("A rebuild is already running")
            view.finish(context.scene, apply=True)
            self._targets = [ob for ob in core.formations() if core.pending(ob)]
            for ob in self._targets:
                if not core.is_solid(ob):
                    core.validate_polygon(core.outline_points(ob))
                core.assert_rebuildable(ob)
            if not self._targets:
                self.report({"INFO"}, "No outline or parameters have changed")
                return {"FINISHED"}
            self._done, self._index, self._cancelled = [], 0, False
            self._launch(context)
            context.scene["formations_busy"] = True
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
        context.scene["formations_progress"] = f"{self._index + 1}/{len(self._targets)}: {ob.name}"
        redraw(context)

    def _cleanup(self, context):
        context.window_manager.event_timer_remove(self._timer)
        context.scene["formations_busy"] = False
        context.scene["formations_progress"] = ""
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
            elif self.action == "OUTLINE":
                guide = bpy.data.objects[ob["formation_outline"]]
                core.collection(core.RECIPES).hide_viewport = False
                bpy.ops.object.select_all(action="DESELECT")
                guide.select_set(True)
                context.view_layer.objects.active = guide
            elif self.action == "SOURCES":
                core.collection(core.RECIPES).hide_viewport = False
                bpy.data.collections[ob["formation_sources"]].hide_viewport = False
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
            view.finish(context.scene, apply=True)
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


class FORMATIONS_OT_edit(bpy.types.Operator):
    """Edit outlines as the game camera sees them"""
    bl_idname = "formations.edit"
    bl_label = "Edit Outlines"
    bl_options = {"REGISTER", "UNDO"}

    action: StringProperty(default="START")

    def execute(self, context):
        try:
            if context.scene.get("formations_busy"):
                raise ValueError("Wait for the rebuild to finish")
            if self.action == "START":
                # A solid formation has a guide mesh, edited as any mesh is.
                targets = [r for r in selected_formations(context) or core.formations() if not core.is_solid(r)]
                view.start(context, targets)
            elif self.action == "APPLY":
                editing = context.mode == "EDIT_CURVE"
                count = view.apply_outlines(context.scene)
                self.report({"INFO"}, f"Applied {count} outlines; rebuild changed formations")
                if editing:
                    view.resume_points(context)
            elif self.action == "FINISH":
                view.finish(context.scene, apply=True)
            elif self.action == "DISCARD":
                view.finish(context.scene, apply=False)
            redraw(context)
            return {"FINISHED"}
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}


class FORMATIONS_OT_polygon(bpy.types.Operator):
    """Change the outlines being edited"""
    bl_idname = "formations.polygon"
    bl_label = "Outline Polygon"
    bl_options = {"REGISTER", "UNDO"}

    action: StringProperty(default="COPY")

    @classmethod
    def poll(cls, context):
        return view.STATE in context.scene and not context.scene.get("formations_busy")

    def execute(self, context):
        try:
            self.report({"INFO"}, view.polygon_action(context, self.action))
            redraw(context)
            return {"FINISHED"}
        except ValueError as e:
            if view.STATE in context.scene:
                view.resume_points(context)
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}


class FORMATIONS_OT_depth(bpy.types.Operator):
    """Move the selected formations away from or toward the game camera"""
    bl_idname = "formations.depth"
    bl_label = "Move Depth"
    bl_options = {"REGISTER", "UNDO"}

    direction: FloatProperty(default=1)

    def execute(self, context):
        editing = context.mode == "EDIT_CURVE"
        try:
            if view.STATE in context.scene:
                rocks = [view.owner_for(h) for h in view.selected_handles(context)]
                rocks = [r for r in rocks if r is not None]
            else:
                rocks = selected_formations(context)
            delta = self.direction * context.scene.formations_depth_step
            count = view.move_depth(context, rocks, delta, context.scene.formations_depth_keep_size)
            if editing:
                view.resume_points(context)
            redraw(context)
            self.report({"INFO"}, f"Moved {count} formations {'back' if delta > 0 else 'forward'}; replant their growth")
            return {"FINISHED"}
        except ValueError as e:
            if editing:
                view.resume_points(context)
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}


CLASSES = (FORMATIONS_OT_look, FORMATIONS_OT_ride, FORMATIONS_OT_generate, FORMATIONS_OT_rebuild_changed, FORMATIONS_OT_action,
           FORMATIONS_OT_plant, FORMATIONS_OT_tone_facets, FORMATIONS_OT_repaint_slate, FORMATIONS_OT_edit,
           FORMATIONS_OT_polygon, FORMATIONS_OT_depth)
