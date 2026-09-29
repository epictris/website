"""The Formations panel's operators."""

from __future__ import annotations

import bpy
from bpy.props import BoolProperty, EnumProperty, FloatProperty, IntProperty, StringProperty

from . import core, growth, view


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
    ob = context.active_object
    if not core.is_formation(ob):
        found = selected_formations(context)
        ob = found[0] if len(found) == 1 else None
    if ob is None:
        raise ValueError("Select a formation")
    return ob


class FORMATIONS_OT_look(bpy.types.Operator):
    """Make the game camera the scene camera and look through it"""
    bl_idname = "formations.look"
    bl_label = "Look Through Game Camera"

    def execute(self, context):
        try:
            cam = view.look_through(context)
            self.report({"INFO"}, f"Game camera: {cam.get('game_source', '')}")
            return {"FINISHED"}
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}


class FORMATIONS_OT_generate(bpy.types.Operator):
    """Build a formation's rock in a separate process; the scene stays editable"""
    bl_idname = "formations.generate"
    bl_label = "Generate Formation"
    bl_options = {"REGISTER", "UNDO"}

    mode: EnumProperty(items=[("CREATE", "Create", ""), ("REBUILD", "Rebuild", ""), ("VARIANT", "New variant", "")])
    preset: EnumProperty(items=[(x.upper(), x.title(), "") for x in ("terrace", "pillar", "wall", "arch", "distant")])
    seed: IntProperty(default=31, min=0)
    depth: FloatProperty(name="Thickness", default=1.05, min=.02, max=50)
    fractures: FloatProperty(default=1.3, min=.5, max=30)
    weathering: FloatProperty(default=.25, min=0, max=1)
    detail: IntProperty(name="Face budget", default=1000, min=200, max=10000)
    use_outline: BoolProperty(name="From the selected closed poly curve", default=False)

    def invoke(self, context, event):
        if self.mode != "CREATE":
            try:
                r = core.recipe_for(active_formation(context))
                self.preset = r["preset"].upper()
                p = r["params"]
                self.seed, self.depth, self.fractures = p["seed"], p["depth"], p["slabsPerArea"]
                self.weathering, self.detail = p["weathering"], p["faceBudget"]
            except (KeyError, ValueError) as e:
                self.report({"ERROR"}, str(e))
                return {"CANCELLED"}
        return context.window_manager.invoke_props_dialog(self, width=340)

    def draw(self, context):
        for field in ("preset", "seed", "depth", "fractures", "weathering", "detail"):
            self.layout.prop(self, field)
        if self.mode == "CREATE":
            self.layout.prop(self, "use_outline")
        self.layout.label(text="Builds in a separate process; Esc discards the result.")

    def execute(self, context):
        try:
            self._target = None if self.mode == "CREATE" and not self.use_outline else (
                context.active_object if self.mode == "CREATE" else active_formation(context))
            recipe = {"preset": self.preset.lower()}
            if self.mode == "REBUILD":
                core.assert_rebuildable(self._target)
            if self.mode != "CREATE":
                recipe = core.recipe_for(self._target)
            elif self.use_outline:
                ob = self._target
                if not ob or ob.type != "CURVE" or len(ob.data.splines) != 1:
                    raise ValueError("Select a single closed poly curve")
                sp = ob.data.splines[0]
                if sp.type != "POLY" or not sp.use_cyclic_u or any(abs(p.co.y) > .001 for p in sp.points):
                    raise ValueError("Use a closed POLY curve in its local X/Z plane")
                recipe["outline"] = [[p.co.x, p.co.z] for p in sp.points]
            recipe["preset"] = self.preset.lower()
            recipe.setdefault("params", {}).update(seed=self.seed, depth=self.depth, slabsPerArea=self.fractures,
                                                   weathering=self.weathering, faceBudget=self.detail)
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
                ob = core.append_rock(self._out / "rock.blend", self.preset.title())
                if self._target is not None:
                    ob.parent.matrix_world = self._target.matrix_world.copy()
                else:
                    ob.parent.location = context.scene.cursor.location
            else:
                if self._target.name not in bpy.data.objects:
                    raise ValueError("The formation was deleted; the result is in " + str(self._out))
                ob = core.replace_from_worker(self._target, self._out / "rock.blend", self.mode == "VARIANT")
            bpy.ops.object.select_all(action="DESELECT")
            ob.select_set(True)
            context.view_layer.objects.active = ob
            self.report({"INFO"}, "Formation ready; replant its growth")
            return {"FINISHED"}
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}


class FORMATIONS_OT_rebuild_changed(bpy.types.Operator):
    """Rebuild every formation whose outline changed, one rock at a time; the
    meshes are swapped only once every rock has built and validated"""
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
                core.validate_polygon(core.outline_points(ob))
                core.assert_rebuildable(ob)
            if not self._targets:
                self.report({"INFO"}, "No outline has changed")
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
                    raise ValueError(ob.name + ": outline changed while it built; rebuild again")
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
                raise ValueError("Rebuild changed outlines first: " + ", ".join(pending))
            if not rocks:
                self.report({"INFO"}, "Nothing to replant")
                return {"FINISHED"}
            report = growth.plant(rocks, context.scene)
            self.report({"INFO"}, f"Replanted {len(report)} formations, {sum(report.values())} pieces")
            return {"FINISHED"}
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}


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
                targets = selected_formations(context) or core.formations()
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


CLASSES = (FORMATIONS_OT_look, FORMATIONS_OT_generate, FORMATIONS_OT_rebuild_changed, FORMATIONS_OT_action,
           FORMATIONS_OT_plant, FORMATIONS_OT_edit, FORMATIONS_OT_polygon, FORMATIONS_OT_depth)
