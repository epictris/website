"""The Formations panel's operators."""

from __future__ import annotations

import math

import bpy
from mathutils import Matrix, Vector
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
    if ob.library is not None or any(c.name == core.COLLISION for c in ob.users_collection):
        raise ValueError("The level's guide is a reference only; model a mesh of your own")
    world = core.authored_world(ob)
    return {"verts": [[round(c, 6) for c in world @ v.co] for v in ob.data.vertices],
            "faces": [list(p.vertices) for p in ob.data.polygons]}


def outline_of_curve(ob):
    """The outline a new formation takes from a selected guide curve, in the
    guide's own X/Z plane (a flat curve is brought to that first, in place),
    and the frame its rock is placed in: where the guide stands. A collision
    outline is refused: it is a reference, and a rock is built from a guide."""
    if core.is_collision_outline(ob):
        raise ValueError("Collision outlines are a reference only: Create Guide from Outline, then build from the guide")
    if not ob or ob.type != "CURVE":
        raise ValueError("Select a guide curve")
    if ob.get("formation_outline_owner"):
        # Another rock's guide: read, never adopted (that rock keeps it).
        sp = ob.data.splines[0] if len(ob.data.splines) == 1 else None
        if sp is None or sp.type != "POLY" or not sp.use_cyclic_u or ob.data.dimensions != "3D":
            raise ValueError("Use a closed POLY curve")
        return [[p.co.x, p.co.z] for p in sp.points], core.authored_world(ob).copy()
    return core.flatten_guide(ob), core.authored_world(ob).copy()


def screen_outline(region, rv3d, ob):
    """Collision outline `ob`'s outer polygon in `region`'s pixels, or None
    where part of it is behind the view."""
    from bpy_extras.view3d_utils import location_3d_to_region_2d
    if not ob.data.splines:
        return None
    world = core.authored_world(ob)
    points = []
    for p in ob.data.splines[0].points:
        q = location_3d_to_region_2d(region, rv3d, world @ Vector(p.co[:3]))
        if q is None:
            return None
        points.append(q)
    return points if len(points) >= 3 else None


def polygon_hit(points, x, y, reach=6.0):
    """Whether pixel (x, y) is inside `points` or within `reach` of an edge,
    and the polygon's area (the innermost of nested outlines wins a click)."""
    inside, near, area = False, False, 0.0
    for a, b in zip(points, points[1:] + points[:1]):
        area += a.x * b.y - b.x * a.y
        if (a.y > y) != (b.y > y) and x < a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y):
            inside = not inside
        ab = b - a
        t = 0.0 if ab.length_squared == 0 else max(0.0, min(1.0, (Vector((x, y)) - a).dot(ab) / ab.length_squared))
        near = near or (a + ab * t - Vector((x, y))).length <= reach
    return inside or near, abs(area) / 2


def view_region_at(context, x, y):
    """The 3D viewport's main region under window pixel (x, y), if any."""
    for area in context.window.screen.areas:
        if area.type != "VIEW_3D":
            continue
        for region in area.regions:
            if region.type == "WINDOW" and region.x <= x < region.x + region.width and region.y <= y < region.y + region.height:
                return region
    return None


def outline_at(context, x, y):
    """The collision outline under window pixel (x, y): the smallest one
    whose inside or edge the pixel is on."""
    region = view_region_at(context, x, y)
    if region is None:
        return None
    best = None
    for ob in core.collision_outlines(context.scene):
        if not ob.visible_get(view_layer=context.view_layer):
            continue
        points = screen_outline(region, region.data, ob)
        if points is None:
            continue
        hit, area = polygon_hit(points, x - region.x, y - region.y)
        if hit and (best is None or area < best[1]):
            best = (ob, area)
    return best[0] if best else None


def draw_hover(op):
    """Highlight the outline under the cursor in the region being drawn."""
    import gpu
    from gpu_extras.batch import batch_for_shader
    from mathutils.geometry import tessellate_polygon
    ob = next((o for o in core.collision_outlines(bpy.context.scene) if o.name == op._hover), None)
    region = bpy.context.region
    if ob is None or region is None or region.data is None:
        return
    points = screen_outline(region, region.data, ob)
    if points is None:
        return
    gpu.state.blend_set("ALPHA")
    flat = [(p.x, p.y) for p in points]
    fill = gpu.shader.from_builtin("UNIFORM_COLOR")
    tris = batch_for_shader(fill, "TRIS", {"pos": flat}, indices=tessellate_polygon([[(*p, 0) for p in flat]]))
    fill.bind()
    fill.uniform_float("color", (*core.GUIDE_COLOURS[0], .18))
    tris.draw(fill)
    line = gpu.shader.from_builtin("POLYLINE_UNIFORM_COLOR")
    line.uniform_float("viewportSize", (region.width, region.height))
    line.uniform_float("lineWidth", 2.0)
    line.uniform_float("color", (*core.GUIDE_COLOURS[0], 1.0))
    batch_for_shader(line, "LINE_STRIP", {"pos": flat + flat[:1]}).draw(line)
    gpu.state.blend_set("NONE")


class FORMATIONS_OT_guide_from_outline(bpy.types.Operator):
    """Copy one of the level's collision outlines into a new guide, to edit and build a formation from.
    Click an outline in the viewport; Shift+click for more, Esc or right-click ends"""
    bl_idname = "formations.guide_from_outline"
    bl_label = "Create Guide from Outline"
    bl_options = {"REGISTER", "UNDO"}

    outline: StringProperty(name="Collision outline",
                            description="The outline to copy, by name; empty picks one in the viewport")

    def made(self, context, outline):
        guide = core.guide_from_outline(outline)
        if not self._made:
            if context.mode != "OBJECT":
                bpy.ops.object.mode_set(mode="OBJECT")
            bpy.ops.object.select_all(action="DESELECT")
        guide.select_set(True)
        context.view_layer.objects.active = guide
        self._made.append(guide.name)

    def execute(self, context):
        self._made = []
        try:
            ob = next((o for o in core.collision_outlines(context.scene) if o.name == self.outline), None)
            if ob is None:
                raise ValueError("No collision outline called " + repr(self.outline))
            self.made(context, ob)
            self.report({"INFO"}, "Guide created; edit it, then New Formation builds from it")
            return {"FINISHED"}
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}

    def invoke(self, context, event):
        if self.outline:
            return self.execute(context)
        if view.STATE in context.scene:
            self.report({"ERROR"}, "Finish editing guides first")
            return {"CANCELLED"}
        if not core.collision_outlines(context.scene):
            self.report({"ERROR"}, "No collision outlines: run `just scene-guide <level>` and reopen the file")
            return {"CANCELLED"}
        self._made, self._hover = [], ""
        self._draw = bpy.types.SpaceView3D.draw_handler_add(draw_hover, (self,), "WINDOW", "POST_PIXEL")
        context.window_manager.modal_handler_add(self)
        context.workspace.status_text_set("Click a collision outline to copy it into a guide   "
                                          "Shift+click: and keep picking   Esc / right-click: done")
        return {"RUNNING_MODAL"}

    def end(self, context):
        bpy.types.SpaceView3D.draw_handler_remove(self._draw, "WINDOW")
        context.workspace.status_text_set(None)
        redraw(context)
        if not self._made:
            return {"CANCELLED"}
        self.report({"INFO"}, f"Created {len(self._made)} guides; edit them, then New Formation builds from one")
        return {"FINISHED"}

    def modal(self, context, event):
        if event.type in {"MOUSEMOVE", "INBETWEEN_MOUSEMOVE"}:
            hover = outline_at(context, event.mouse_x, event.mouse_y)
            name = hover.name if hover else ""
            if name != self._hover:
                self._hover = name
                redraw(context)
            return {"PASS_THROUGH"}
        if event.value != "PRESS":
            return {"PASS_THROUGH"}
        if event.type in {"ESC", "RIGHTMOUSE"}:
            return self.end(context)
        if event.type != "LEFTMOUSE":
            return {"PASS_THROUGH"}
        if view_region_at(context, event.mouse_x, event.mouse_y) is None:
            # A click on the panel or elsewhere ends the pick and goes on.
            self.end(context)
            return {"FINISHED", "PASS_THROUGH"} if self._made else {"CANCELLED", "PASS_THROUGH"}
        outline = outline_at(context, event.mouse_x, event.mouse_y)
        if outline is None:
            self.report({"WARNING"}, "No collision outline there")
            return {"RUNNING_MODAL"}
        try:
            self.made(context, outline)
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"RUNNING_MODAL"}
        return {"RUNNING_MODAL"} if event.shift else self.end(context)


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
    use_outline: BoolProperty(name="From the selected guide (a closed poly curve)", default=False)
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
            if context.scene.get("formations_busy"):
                raise ValueError("A rebuild is already running")
            view.finish(context.scene, apply=True)
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
    """Edit formation guides as the game camera sees them (never the collision outlines)"""
    bl_idname = "formations.edit"
    bl_label = "Edit Guides"
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
                self.report({"INFO"}, f"Applied {count} guides; rebuild changed formations")
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
    """Change the guides being edited"""
    bl_idname = "formations.polygon"
    bl_label = "Guide Polygon"
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


CLASSES = (FORMATIONS_OT_look, FORMATIONS_OT_ride, FORMATIONS_OT_guide_from_outline, FORMATIONS_OT_generate, FORMATIONS_OT_rebuild_changed, FORMATIONS_OT_action,
           FORMATIONS_OT_plant, FORMATIONS_OT_tone_facets, FORMATIONS_OT_repaint_slate, FORMATIONS_OT_edit,
           FORMATIONS_OT_polygon, FORMATIONS_OT_depth)
