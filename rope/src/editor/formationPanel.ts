// The Formation section of a body's panel (docs/formations.md, "Guides and
// formations"): the generator and its parameters, Generate and Bake, the tier
// the game loads, and the three buttons of the collision guide workflow.
//
// Built from the generators' schema (`formationSchema.json`), so a parameter
// added to the Blender add-on appears here once the schema is exported again.
// A formation is edited in place: there is no workspace for it.

import * as THREE from "three";
import { PIXELS_PER_METER, PX } from "../engine/units";
import { Vec2 } from "../engine/vec2";
import { showToast } from "../render/toast";
import { meshLeafTree, needsApply, newPrimitive, nodeAt, nodeLabel, replaceAt } from "../formation/solidTree";
import { appendEntry, isGroup, moveEntry, removeEntry, setMode, stackOf } from "../formation/solidStack";
import { MESHES_API } from "../formation/store";
import { scaleLevelData, type LevelData, type SolidNode, type SolidPrim } from "../level/levelFormat";
import { guideBounds, guideMesh, requestMeshes, storeMesh, type SolidSel } from "./solidGuides";
import { formationHash, generatorsFor, isStale, newFormationId, resolvedParams, variantOf, visibleFields, FORMATION_SCHEMA } from "../formation/recipe";
import { metaFile, type FormationMeta } from "../formation/store";
import type { FormationGenerator, SolidVariant } from "../level/levelFormat";
import { autoTier } from "../render3d/formations";
import { alignCollisionToGuide, applyFit, collisionMatchesGuide, enclosingItem, formationItemOf, guideFromCollision, previewFit } from "./formationEdit";
import type { FormationJobs, JobState } from "./formationJobs";
import { bodyFrameOf, bodyLead, bodyMembers, formationItem, modelFromDisk, newBodyId, type EdFormation, type EdItem, type EdModel } from "./model";
import { describe, fieldRow } from "./panelUi";

export interface FormationHost {
  model(): EdModel;
  jobs: FormationJobs;
  // The solid guide's node the panel has picked, which the gizmo moves.
  solidSel(): SolidSel | null;
  setSolidSel(sel: SolidSel | null): void;
  beginAction(): void;
  markDirty(): void;
  rebuildInspector(): void;
  // A label for the body in the jobs panel.
  bodyName(bodyId: number): string;
  // Sculpt mode on this formation's guide (editor/sculpt.ts), where the
  // editor has it, and the formation item being sculpted now.
  sculpt?(item: EdItem): void;
  sculpting?(): number | null;
}

// What the store says of a built formation, by hash: fetched once each.
const metas = new Map<string, FormationMeta | null | "loading">();
export function formationMeta(hash: string, then: () => void): FormationMeta | null | undefined {
  const have = metas.get(hash);
  if (have === "loading") return undefined;
  if (have !== undefined) return have;
  metas.set(hash, "loading");
  fetch(metaFile(hash), { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<FormationMeta>) : null))
    .catch(() => null)
    .then((m) => {
      metas.set(hash, m);
      then();
    });
  return undefined;
}
// A bake rewrites the meta under the same hash (it adds the tiers).
export function forgetFormationMeta(hash: string): void {
  metas.delete(hash);
}

// Record a finished job's result on every formation whose recipe it is:
// what they draw is now that. Returns whether anything changed.
// Returns the formation items whose drawn rock changed.
export function applyJobResult(model: EdModel, job: JobState): EdItem[] {
  const r = job.result;
  if (!r || (job.kind !== "geometry" && job.kind !== "bake")) return [];
  const changed: EdItem[] = [];
  for (const item of model.items) {
    const f = item.formation;
    if (item.object !== "formation" || !f || formationHash(f) !== r.hash) continue;
    const same = f.built?.hash === r.hash && f.built.tiers.length === r.tiers.length && f.built.generatorHash === r.generatorHash;
    if (same) continue;
    item.formation = { ...f, built: { hash: r.hash, front: r.front, generatorHash: r.generatorHash, recipeVersion: r.recipeVersion, tiers: r.tiers } };
    changed.push(item);
  }
  if (changed.length) forgetFormationMeta(r.hash);
  return changed;
}

// The accuracy the last fit was asked at, kept across panels (metres).
let fitAccuracy = 0.03;

const button = (text: string, onClick: () => void, title?: string): HTMLButtonElement => {
  const b = document.createElement("button");
  b.className = "ed-btn";
  b.textContent = text;
  b.addEventListener("click", onClick);
  if (title) b.title = title;
  return b;
};
const div = (cls: string, text = ""): HTMLDivElement => {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  return d;
};

// Ask for a build of `item`'s formation as it stands (also the Formations
// workspace's "Generate N out of date").
export function requestFormationBuild(host: FormationHost, item: EdItem, kind: "geometry" | "bake"): void {
  const f = item.formation!;
  host.jobs.ask(kind, { ...f }, host.bodyName(item.bodyId)).then(
    () => host.rebuildInspector(),
    (e: Error) => showToast(`The job runner refused the build: ${e.message}`, "warn"),
  );
}

// THE LAST RECIPE SET, per kind of guide: what a new formation starts from,
// as Blender's operators start from the settings last used. Set by any edit
// of a recipe in the Formation section; kept in this browser (a per-viewer
// convenience, never written into a level), and read guarded, since
// `localStorage` throws in some privacy modes.
type Recipe = Pick<EdFormation, "generator" | "variant" | "params">;
const RECIPE_KEY = "rope.formation.lastRecipe";
// This session's, which wins (and is all there is where storage throws).
let sessionRecipes: Partial<Record<"collision" | "solid", Recipe>> | null = null;
function readRecipes(): Partial<Record<"collision" | "solid", Recipe>> {
  if (sessionRecipes) return sessionRecipes;
  try {
    sessionRecipes = JSON.parse(localStorage.getItem(RECIPE_KEY) ?? "{}") as Partial<Record<"collision" | "solid", Recipe>>;
  } catch {
    sessionRecipes = {};
  }
  return sessionRecipes;
}
function rememberRecipe(f: EdFormation): void {
  const all = { ...readRecipes(), [f.guide.kind]: { generator: f.generator, ...(f.variant ? { variant: f.variant } : {}), params: { ...f.params } } };
  sessionRecipes = all;
  try {
    localStorage.setItem(RECIPE_KEY, JSON.stringify(all));
  } catch {
    // Kept for this session only.
  }
}
// The remembered recipe for a guide kind, if its generator still offers it.
export function lastRecipe(kind: "collision" | "solid"): Recipe | null {
  const r = readRecipes()[kind];
  if (!r || !FORMATION_SCHEMA.generators[r.generator]) return null;
  if (kind === "collision" && !FORMATION_SCHEMA.outline.includes(r.generator)) return null;
  return { generator: r.generator, ...(r.variant ? { variant: r.variant } : {}), params: { ...r.params } };
}

// A formation for `bodyId` that is not in the level yet: its guide taken from
// the body's collision, at the body's frame, its recipe the last one set.
function newFormationFor(model: EdModel, bodyId: number, generator: FormationGenerator): EdItem {
  const members = bodyMembers(model.items, bodyId);
  const frame = bodyFrameOf(model, bodyId);
  const taken = new Set(model.items.flatMap((i) => (i.formation ? [i.formation.id] : [])));
  const last = lastRecipe("collision");
  const item = formationItem(bodyLead(members) ?? members[0]!, frame.pos, frame.rot, {
    id: newFormationId(taken),
    generator: last?.generator ?? generator,
    ...(last?.variant ? { variant: last.variant } : {}),
    params: last?.params ?? {},
    guide: { kind: "collision", pieces: [] },
  });
  item.formation = { ...item.formation!, guide: guideFromCollision(model, bodyId) };
  return item;
}

// THE DRAFT: a body with collision and no formation shows the whole recipe -
// generator, variant, parameters - on a formation that is not in the level,
// so it is set up first and Generate is the one act that adds it (an
// unbuilt formation is never left in a level by looking at a panel). It is
// made afresh from the last recipe set every time the panel is built, and
// every edit of it sets that recipe, so what was set carries to the next
// body selected as it stays on this one.

// The draft into the level, its guide taken from the collision as it is
// now, as one undo step.
function commitDraft(host: FormationHost, bodyId: number, draft: EdItem): EdItem {
  const model = host.model();
  host.beginAction();
  const members = bodyMembers(model.items, bodyId);
  const item = newFormationFor(model, bodyId, draft.formation!.generator);
  item.formation = { ...draft.formation!, id: item.formation!.id, guide: item.formation!.guide };
  const last = model.items.lastIndexOf(members[members.length - 1]!);
  model.items.splice(last + 1, 0, item);
  host.markDirty();
  return item;
}

export function buildFormationSection(outerHost: FormationHost, parent: HTMLElement, bodyId: number): void {
  const model = outerHost.model();
  const inLevel = formationItemOf(model, bodyId);
  const pieces = bodyMembers(model.items, bodyId).filter(enclosingItem);

  if (!inLevel && !pieces.length) {
    parent.appendChild(div("ed-hint", "No collision piece encloses anything here to grow a rock from."));
    return;
  }
  // No formation yet: the draft's recipe (see `drafts`), edited with nothing
  // marked as an edit of the level, until Generate puts it there.
  const isDraft = !inLevel;
  const item = inLevel ?? newFormationFor(model, bodyId, FORMATION_SCHEMA.outline[0]!);
  const host: FormationHost = isDraft ? { ...outerHost, beginAction: () => {}, markDirty: () => {} } : outerHost;
  if (isDraft) {
    parent.appendChild(div("ed-hint", `Set the recipe, then Generate: the guide is taken from ${pieces.length} piece${pieces.length === 1 ? "" : "s"} of this body's collision.`));
  }

  const f = item.formation!;
  const hash = formationHash(f);
  const stale = isStale(f);
  const replace = (next: Partial<EdFormation>): void => {
    item.formation = { ...item.formation!, ...next };
    // What was just set is what the next new formation starts from.
    rememberRecipe(item.formation);
  };

  // What is drawn, and whether it is what the recipe now asks for.
  const status = div("ed-hint ed-formation-status");
  const refreshStatus = (): void => {
    const now = item.formation!;
    const job = host.jobs.latest(formationHash(now));
    const running = job && (job.state === "queued" || job.state === "running");
    const fp = host.jobs.fingerprint(() => host.rebuildInspector());
    const lines: string[] = [];
    let warned = false;
    if (!now.built) lines.push("Not generated yet.");
    else {
      const tiers = now.built.tiers.length;
      lines.push(`Drawn: ${now.built.hash.slice(0, 10)}, ${tiers ? `baked, ${tiers} tier${tiers === 1 ? "" : "s"}` : "not baked (the iteration look)"}.`);
      if (isStale(now)) lines.push("STALE: the guide or the recipe has changed since. Regenerate to see it.");
      if (fp && now.built.generatorHash !== fp) lines.push("Built by an older generator: Regenerate builds it with the current code.");
      // What the build noticed about what is drawn (a variant that filled its
      // guide's opening).
      const meta = formationMeta(now.built.hash, refreshStatus);
      for (const w of meta?.warnings ?? []) lines.push(`WARNING: ${w}.`);
      warned = !!meta?.warnings?.length;
    }
    if (running) lines.push(`${job.kind === "bake" ? "Baking" : "Generating"}: ${Math.round((job.progress ?? 0) * 100)}% ${job.step ?? ""}`);
    else if (job?.state === "failed") lines.push(`The last ${job.kind} failed: ${job.error?.split("\n").pop() ?? ""} (see Jobs)`);
    status.textContent = lines.join(" ");
    status.classList.toggle("ed-stale", isStale(now) || warned);
  };
  refreshStatus();
  // The jobs panel's changes reach here as this event (editor.ts).
  status.addEventListener("refresh", refreshStatus);
  // A draft's hint above says what its status would ("not generated").
  if (!isDraft) parent.appendChild(status);

  // Generator (and variant), from the schema.
  const kinds = generatorsFor(f.guide);
  if (kinds.length > 1) {
    const row = fieldRow("generator");
    const pick = Object.assign(document.createElement("select"), { className: "ed-select" });
    for (const g of kinds) pick.add(new Option(FORMATION_SCHEMA.generators[g].label, g));
    pick.value = f.generator;
    pick.addEventListener("change", () => {
      host.beginAction();
      replace({ generator: pick.value as FormationGenerator });
      host.markDirty();
      host.rebuildInspector();
    });
    row.appendChild(pick);
    describe(row, "What builds the rock: the outline generators fit rock to the guide's outline (docs/blender-formations.md).");
    parent.appendChild(row);
  }
  const variants = FORMATION_SCHEMA.generators[f.generator].variants;
  if (variants) {
    const row = fieldRow("variant");
    const pick = Object.assign(document.createElement("select"), { className: "ed-select" });
    for (const v of variants) pick.add(new Option(v.label, v.id));
    pick.value = variantOf(f)!;
    pick.addEventListener("change", () => {
      host.beginAction();
      replace({ variant: pick.value as SolidVariant });
      host.markDirty();
      host.rebuildInspector();
    });
    row.appendChild(pick);
    describe(row, variants.find((v) => v.id === pick.value)?.description ?? "");
    parent.appendChild(row);
  }

  // The parameters. Each typed value replaces the formation (never mutates
  // it: an undo snapshot holds the old one).
  const params = resolvedParams(f);
  let typing = false;
  for (const spec of visibleFields(f.generator, variantOf(f))) {
    const row = fieldRow(spec.unit ? `${spec.label} (${spec.unit})` : spec.label);
    const input = document.createElement("input");
    if (spec.type === "bool") {
      input.type = "checkbox";
      input.checked = params[spec.key] === true;
      input.addEventListener("change", () => {
        host.beginAction();
        replace({ params: { ...item.formation!.params, [spec.key]: input.checked } });
        host.markDirty();
        refreshStatus();
      });
    } else {
      input.type = "number";
      input.className = "ed-num";
      input.step = spec.type === "int" ? "1" : String(10 ** -(spec.precision ?? 2));
      if (spec.min !== undefined) input.min = String(spec.min);
      if (spec.max !== undefined) input.max = String(spec.max);
      // Six significant digits, as the add-on's fields hold them: a value
      // converted from an older recipe is not shown with its float noise.
      input.value = String(Number(Number(params[spec.key]).toPrecision(6)));
      input.addEventListener("focus", () => (typing = false));
      input.addEventListener("input", () => {
        let v = parseFloat(input.value);
        if (!Number.isFinite(v)) return;
        if (spec.type === "int") v = Math.round(v);
        if (spec.min !== undefined) v = Math.max(spec.min, v);
        if (spec.max !== undefined) v = Math.min(spec.max, v);
        // One undo step per editing session of a field.
        if (!typing) {
          host.beginAction();
          typing = true;
        }
        replace({ params: { ...item.formation!.params, [spec.key]: v } });
        host.markDirty();
        refreshStatus();
      });
    }
    row.appendChild(input);
    describe(row, `${spec.description}${spec.default !== undefined ? ` Default ${spec.default}.` : ""}`);
    parent.appendChild(row);
  }

  // Generate and Bake.
  const actions = div("ed-row");
  const gen = button(f.built ? "Regenerate" : "Generate", () => {
    // A draft goes into the level first, with the recipe as it was set.
    const target = isDraft ? commitDraft(outerHost, bodyId, item) : item;
    requestFormationBuild(outerHost, target, "geometry");
    if (isDraft) outerHost.rebuildInspector();
  }, "Build the rock from the guide and the parameters as they stand. Fast: the iteration look, no bake.");
  gen.classList.toggle("ed-attention", stale);
  const baked = !!f.built && !stale && f.built.tiers.length > 0;
  const bake = button(baked ? "Baked" : "Bake", () => requestFormationBuild(host, item, "bake"),
    "Bake the rock's textures (Cycles, on the GPU) and its lower tiers: the finished look. One bake runs at a time, and none while ▶ Test runs.");
  bake.disabled = baked || stale || !f.built;
  actions.append(gen);
  // A draft has nothing to bake and nothing built to fit, tier or decorate:
  // the section is its recipe and Generate.
  if (isDraft) {
    parent.appendChild(actions);
    return;
  }
  actions.append(bake);
  const job = host.jobs.latest(hash);
  if (job && (job.state === "queued" || job.state === "running")) {
    actions.appendChild(button("Cancel", () => host.jobs.cancel(job.id)));
  }
  parent.appendChild(actions);

  // The tier the game loads.
  if (f.built?.tiers.length) {
    const row = fieldRow("tier");
    const pick = Object.assign(document.createElement("select"), { className: "ed-select" });
    const auto = autoTier(-f.built.front, f.built.tiers.length);
    pick.add(new Option(`auto (tier ${auto})`, "auto"));
    f.built.tiers.forEach((t, k) =>
      pick.add(new Option(`tier ${k}: ${t.triangles.toLocaleString()} tris, ${t.colour}/${t.normal}, ${Math.round(t.bytes / 1024)} KB`, String(k))),
    );
    pick.value = typeof f.lod === "number" ? String(f.lod) : "auto";
    pick.addEventListener("change", () => {
      host.beginAction();
      if (pick.value === "auto") {
        const { lod: _l, ...rest } = item.formation!;
        item.formation = rest;
      } else replace({ lod: Number(pick.value) });
      host.markDirty();
    });
    row.appendChild(pick);
    describe(row, "Which tier of the bake the game loads. Automatic chooses by how far behind the play plane the rock stands.");
    parent.appendChild(row);
  }

  if (f.guide.kind === "solid") {
    buildSolidGuideSection(host, parent, item);
    return;
  }
  const guide = f.guide;

  // The guide's pieces: which of the body's pieces it is taken from.
  if (pieces.length > 1) {
    const row = fieldRow("guide pieces", "div");
    const chosen = new Set(guide.subset ?? pieces.map((_, k) => k));
    pieces.forEach((p, k) => {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = chosen.has(k);
      box.addEventListener("change", () => {
        if (box.checked) chosen.add(k);
        else chosen.delete(k);
        if (!chosen.size) {
          box.checked = true;
          chosen.add(k);
          return;
        }
        host.beginAction();
        const subset = chosen.size === pieces.length ? undefined : [...chosen].sort((a, b) => a - b);
        replace({ guide: guideFromCollision(host.model(), bodyId, subset) });
        host.markDirty();
        host.rebuildInspector();
      });
      label.append(box, ` ${k + 1}:${p.shape.kind}`);
      row.appendChild(label);
    });
    describe(row, "The body's pieces the guide is the union of. Changing them takes the guide again from those pieces as they are now.");
    parent.appendChild(row);
  }

  // Whether the collision is the guide: information, not a warning.
  const matches = collisionMatchesGuide(model, bodyId, guide);
  parent.appendChild(div("ed-hint", matches
    ? "The collision matches the guide."
    : "The collision differs from the guide (expected after a fit). Align collision to guide before reshaping it."));

  // Fit collision to geometry.
  const fit = div("ed-formation-fit");
  const fitRow = fieldRow("fit accuracy (px)");
  const acc = document.createElement("input");
  acc.type = "number";
  acc.className = "ed-num";
  acc.min = "0.1";
  acc.step = "0.5";
  acc.value = String(Math.round((fitAccuracy / PX) * 10) / 10);
  fitRow.appendChild(acc);
  describe(fitRow, "The furthest the fitted outline may stray from where the rock meets the play plane. Looser gives fewer vertices.");
  const count = div("ed-hint");
  const fitButton = button("Fit collision to geometry", () => {
    const meta = f.built ? formationMeta(f.built.hash, () => {}) : null;
    if (!meta) return;
    host.beginAction();
    const preview = previewFit(host.model(), bodyId, meta.section, fitAccuracy);
    applyFit(host.model(), bodyId, item, preview);
    host.markDirty();
    host.rebuildInspector();
  }, "Replace this body's collision with the outline of the rock where it meets the play plane, within the accuracy. Pieces with different properties are fitted each on its own. Recordings made before diverge.");
  const showCount = (): void => {
    if (!f.built) {
      count.textContent = "Generate first: the fit is to the rock that was built.";
      fitButton.disabled = true;
      return;
    }
    const meta = formationMeta(f.built.hash, showCount);
    if (meta === undefined) {
      count.textContent = "Reading the rock's section…";
      fitButton.disabled = true;
      return;
    }
    if (meta === null) {
      count.textContent = "The store has no meta.json for what is drawn; regenerate.";
      fitButton.disabled = true;
      return;
    }
    const p = previewFit(host.model(), bodyId, meta.section, fitAccuracy);
    const polys = p.polygons.flat().length;
    count.textContent = `${p.vertices} vertices in ${polys} piece${polys === 1 ? "" : "s"}` +
      (p.classes.length > 1 ? `, ${p.classes.length} kinds of piece fitted each on its own` : "") +
      (p.dropped ? `, ${p.dropped} crumb${p.dropped === 1 ? "" : "s"} dropped` : "") +
      (p.open ? `, ${p.open} open loop${p.open === 1 ? "" : "s"} in the section ignored` : "") + ".";
    fitButton.disabled = polys === 0;
  };
  acc.addEventListener("input", () => {
    const v = parseFloat(acc.value);
    if (!(v > 0)) return;
    fitAccuracy = v * PX;
    showCount();
  });
  showCount();
  const fitActions = div("ed-row");
  fitActions.appendChild(fitButton);
  fit.append(fitRow, count, fitActions);
  parent.appendChild(fit);

  const align = div("ed-row");
  const toGuide = button("Align collision to guide", () => {
    host.beginAction();
    alignCollisionToGuide(host.model(), bodyId, item);
    host.markDirty();
    host.rebuildInspector();
  }, "Put the collision back exactly as the guide was taken: before reshaping the rock by editing the collision.");
  toGuide.disabled = matches;
  const toCollision = button("Align guide to collision", () => {
    host.beginAction();
    replace({ guide: guideFromCollision(host.model(), bodyId, guide.subset) });
    host.markDirty();
    host.rebuildInspector();
  }, "Take the guide again from the collision as it is now; the rock is then stale until regenerated.");
  toCollision.disabled = matches;
  align.append(toGuide, toCollision);
  parent.appendChild(align);
}

// Every formation built by an older generator than `fingerprint`.
export function olderFormations(model: EdModel, fingerprint: string): EdItem[] {
  return model.items.filter((i) => i.object === "formation" && i.formation?.built && i.formation.built.generatorHash !== fingerprint);
}

// --- solid guides -------------------------------------------------------------

const DEG = 180 / Math.PI;

// A new body behind the play plane holding nothing but a formation on a solid
// guide (a background guide: docs/formations.md), at `at` in the level, made
// through the editor's own load so it is a body like any other.
//
// `shape` (the Formations dock's Primitives, Shift+A with nothing selected)
// makes the guide that one primitive at the body's origin, and `at.z` stands
// the body at that depth: the primitive appears where the view is looking.
// Without it, the default backdrop: a box 2.5 m behind the plane.
export function createBackdrop(host: FormationHost, at: { x: number; y: number; z?: number }, shape?: SolidPrim): EdItem | null {
  const model = host.model();
  const taken = new Set(model.items.flatMap((i) => (i.formation ? [i.formation.id] : [])));
  const data: LevelData = {
    player: { x: 0, y: 0, radius: 0.1 },
    bodies: [{
      kind: "static",
      x: at.x,
      y: at.y,
      rot: 0,
      objects: [],
      formation: {
        id: newFormationId(taken),
        // The last solid recipe set, else Cliff at its defaults.
        generator: lastRecipe("solid")?.generator ?? "solid",
        variant: lastRecipe("solid")?.variant ?? "cliff",
        params: lastRecipe("solid")?.params ?? {},
        guide: { kind: "solid", tree: { op: "union", of: [shape ?? { prim: "box", size: [3, 2, 2], pos: [0, 1, -2.5] }] } },
      },
    }],
  };
  const made = modelFromDisk(scaleLevelData(data, PIXELS_PER_METER)).items.find((i) => i.object === "formation");
  if (!made) return null;
  host.beginAction();
  made.bodyId = newBodyId();
  model.items.push(made);
  // A backdrop is a 3D body (`LevelBodyData.space`): only drawn, so free to
  // stand off the plane and tilt, its frame stated where it was made.
  model.bodyFrames.set(made.bodyId, { pos: new Vec2(at.x, at.y), rot: 0 });
  model.bodies3d.set(made.bodyId, { z: at.z ?? 0, tilt: [0, 0] });
  host.markDirty();
  return made;
}

// Where a new shape goes: the middle of what the guide makes now (its own
// frame), so a box added to cut a backdrop lands IN the backdrop rather than
// on the gameplay plane in front of it. The default backdrop's middle when
// nothing is made yet.
export function guideCentre(tree: SolidNode): [number, number, number] {
  const box = guideBounds(tree);
  return box ? box.getCenter(new THREE.Vector3()).toArray() : [0, 1, -2.5];
}

// A shape added to the end of a solid guide's stack (as an Add; its badge
// makes it a cut), and picked: the panel's add buttons and Shift+A.
export function addShapeToGuide(host: FormationHost, item: EdItem, shape: SolidNode): void {
  const guide = item.formation?.guide;
  if (guide?.kind !== "solid") return;
  host.beginAction();
  const r = appendEntry(guide.tree, shape, "add");
  item.formation = { ...item.formation!, guide: { kind: "solid", tree: r.tree } };
  host.markDirty();
  host.setSolidSel({ itemId: item.id, path: stackOf(r.tree)[r.index]?.path ?? [] });
}

// APPLY (Blender's "apply the modifiers", plans/sculpt-guides.md): the whole
// stack meshed into one stored mesh, and the tree replaced by that one mesh
// leaf, as sculpting needs (a sculpt edits a mesh, not a tree). Destructive
// and one undo step, as Union/Subtract/Intersect are. True once the guide is
// a single mesh leaf; false (with a notice) when it cannot be: the tree makes
// nothing, or a mesh it names is still loading.
export function applyGuide(host: FormationHost, item: EdItem): boolean {
  const guide = item.formation?.guide;
  if (guide?.kind !== "solid") return false;
  const tree = guide.tree;
  if (!needsApply(tree)) return true;
  if (requestMeshes(tree, () => host.rebuildInspector())) {
    showToast("The guide's meshes are still loading; Apply again in a moment.", "warn");
    return false;
  }
  const meshed = guideMesh(tree);
  if (!meshed.mesh) {
    showToast(`Nothing to apply: ${meshed.error ?? "the guide makes no solid"}.`, "warn");
    return false;
  }
  host.beginAction();
  item.formation = { ...item.formation!, guide: { kind: "solid", tree: meshLeafTree(storeMesh(meshed.mesh).name) } };
  host.markDirty();
  host.setSolidSel(null);
  return true;
}

// The shapes Shift+A and the panel offer, by label.
export const SHAPE_KINDS = [
  { label: "Box", kind: "box" },
  { label: "Cylinder", kind: "cylinder" },
] as const;

function buildSolidGuideSection(host: FormationHost, parent: HTMLElement, item: EdItem): void {
  const guide = item.formation!.guide;
  if (guide.kind !== "solid") return;
  const tree = guide.tree;
  const sel = host.solidSel();
  const picked = sel && sel.itemId === item.id ? sel : null;
  const setTree = (next: SolidNode, select?: SolidSel | null): void => {
    item.formation = { ...item.formation!, guide: { kind: "solid", tree: next } };
    host.markDirty();
    if (select !== undefined) host.setSolidSel(select);
    else host.rebuildInspector();
  };
  const edit = (next: SolidNode, select?: SolidSel | null): void => {
    host.beginAction();
    setTree(next, select);
  };

  // Being sculpted: the stack is the sculpt's until it is left (an edit here
  // would be a second author of the guide).
  if (host.sculpting?.() === item.id) {
    parent.appendChild(div("ed-hint", "Sculpting this guide: Draw (D), Grab (G), Cut (C). Done or Esc leaves and saves it; the stack is editable again then."));
    return;
  }

  // Whether the tree makes a solid at all, live (kept per tree: the panel is
  // rebuilt on every selection change, and a sculpt is costly to mesh).
  const meshed = guideMesh(tree);
  const missing = requestMeshes(tree, () => host.rebuildInspector());
  parent.appendChild(div(meshed.mesh ? "ed-hint" : "ed-hint ed-formation-status ed-stale",
    meshed.mesh
      ? `Guide: ${(meshed.mesh.indices.length / 3).toLocaleString()} triangles.`
      : missing ? "Loading the guide's meshes…" : `The guide makes no solid: ${meshed.error ?? "nothing"}. Generate would fail.`));

  // THE STACK (formation/solidStack.ts): the shapes in order, each added to,
  // cut from or intersected with what is above it. A row picks its shape (and
  // so the gizmo); its badge cycles the mode; drag a row to reorder.
  const stack = stackOf(tree);
  const pathOfIndex = (t: SolidNode, i: number): number[] => stackOf(t)[i]?.path ?? [];
  const pickIndex = (t: SolidNode, i: number): SolidSel => ({ itemId: item.id, path: pathOfIndex(t, i) });
  const list = div("ed-solid-tree ed-stack");
  let dragged: number | null = null;
  stack.forEach((entry, i) => {
    const row = div(`ed-solid-row ed-stack-row ed-stack-${entry.mode}`);
    const on = picked !== null && picked.path.join(",") === entry.path.join(",");
    row.classList.toggle("sel", on);
    // The mode: the base is what everything below works on, so it has none.
    const badge = document.createElement("button");
    badge.className = "ed-stack-mode";
    badge.textContent = i === 0 ? "■" : entry.mode === "add" ? "+" : entry.mode === "subtract" ? "−" : "∩";
    badge.title = i === 0
      ? "The base: the shapes below are added to it, cut from it or intersected with it"
      : `${entry.mode === "add" ? "Added to" : entry.mode === "subtract" ? "Cut from" : "Intersected with"} what is above it. Click for the next mode.`;
    badge.disabled = i === 0;
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      const next = entry.mode === "add" ? "subtract" : entry.mode === "subtract" ? "intersect" : "add";
      const r = setMode(tree, i, next);
      edit(r.tree, pickIndex(r.tree, r.index));
    });
    const label = div("ed-stack-label", isGroup(entry) ? `group of ${stackOf(entry.node).length}` : nodeLabel(entry.node));
    const del = document.createElement("button");
    del.className = "ed-stack-del";
    del.textContent = "×";
    del.title = "Remove this shape";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const next = removeEntry(tree, i);
      if (next) edit(next, null);
    });
    if (stack.length < 2) del.disabled = true;
    row.append(badge, label, del);
    row.addEventListener("click", () => host.setSolidSel(pickIndex(tree, i)));
    // Reordered by dragging the row onto another.
    row.draggable = true;
    row.addEventListener("dragstart", () => (dragged = i));
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      if (dragged === null || dragged === i) return;
      const r = moveEntry(tree, dragged, i);
      dragged = null;
      edit(r.tree, pickIndex(r.tree, r.index));
    });
    list.appendChild(row);
  });
  parent.appendChild(list);
  parent.appendChild(div("ed-hint", "Click a shape here or in the view to move, turn and size it. Shift+A adds one."));

  // Adding: at the end of the stack, added; its badge makes it a cut.
  const add = (child: SolidNode): void => {
    const r = appendEntry(tree, child, "add");
    edit(r.tree, pickIndex(r.tree, r.index));
  };
  const centre = guideCentre(tree);
  const adds = div("ed-row");
  adds.append(
    button("+ Box", () => add(newPrimitive("box", centre))),
    button("+ Cylinder", () => add(newPrimitive("cylinder", centre))),
    button("Import mesh…", () => importMesh((name) => add({ prim: "mesh", file: name, pos: [0, 0, 0] })),
      "A fixed closed mesh (.glb or .gltf), placed, turned and scaled here, and sculpted like any guide once applied."),
  );
  parent.appendChild(adds);
  // Apply, and Sculpt (which applies first when it has to).
  const shaping = div("ed-row");
  const apply = button("Apply", () => applyGuide(host, item),
    "Mesh the whole stack into one sculptable mesh (Blender's Apply): the shapes become one, as one undo step");
  apply.disabled = !needsApply(tree) || !meshed.mesh;
  shaping.appendChild(apply);
  if (host.sculpt) {
    const sculpt = button("Sculpt", () => host.sculpt!(item),
      "Sculpt this guide: Draw (D), Grab (G), Cut (C); Ctrl+Tab, Esc or Done leaves. Applies the stack first.");
    sculpt.disabled = !meshed.mesh;
    shaping.appendChild(sculpt);
  }
  parent.appendChild(shaping);

  const node = picked ? nodeAt(tree, picked.path) : null;
  if (!picked || !node) return;
  const path = picked.path;
  // A group is a stack of its own; its shapes are picked in the view.
  if ("op" in node) return;

  // Its pose and its own sizes. Each typed value is one edit session's undo.
  let typing = false;
  const num = (label: string, get: () => number, set: (v: number) => SolidPrim, step = 0.05): void => {
    const row = fieldRow(label);
    const input = document.createElement("input");
    input.type = "number";
    input.className = "ed-num";
    input.step = String(step);
    input.value = String(Math.round(get() * 1e4) / 1e4);
    input.addEventListener("focus", () => (typing = false));
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v)) return;
      if (!typing) {
        host.beginAction();
        typing = true;
      }
      item.formation = { ...item.formation!, guide: { kind: "solid", tree: replaceAt((item.formation!.guide as { tree: SolidNode }).tree, path, () => set(v)) } };
      host.markDirty();
    });
    row.appendChild(input);
    parent.appendChild(row);
  };
  const current = (): SolidPrim => nodeAt((item.formation!.guide as { tree: SolidNode }).tree, path) as SolidPrim;
  const vec = (v: [number, number, number] | undefined, d: number): [number, number, number] => v ? [...v] : [d, d, d];
  (["x", "y", "z"] as const).forEach((axis, k) => num(`at ${axis} (m)`, () => vec(current().pos, 0)[k]!, (v) => {
    const p = vec(current().pos, 0);
    p[k] = v;
    return { ...current(), pos: p };
  }));
  (["x", "y", "z"] as const).forEach((axis, k) => num(`turn ${axis}°`, () => vec(current().rot, 0)[k]! * DEG, (v) => {
    const r = vec(current().rot, 0);
    r[k] = v / DEG;
    return { ...current(), rot: r };
  }, 5));
  (["x", "y", "z"] as const).forEach((axis, k) => num(`scale ${axis}`, () => vec(current().scale, 1)[k]!, (v) => {
    const s = vec(current().scale, 1);
    s[k] = Math.max(0.01, v);
    return { ...current(), scale: s };
  }));
  if (node.prim === "box" || node.prim === "cylinder") {
    (["x", "y", "z"] as const).forEach((axis, k) => num(`size ${axis} (m)`, () => (current() as { size: number[] }).size[k]!, (v) => {
      const c = current() as Extract<SolidPrim, { size: unknown }>;
      const s: [number, number, number] = [...c.size];
      s[k] = Math.max(0.01, v);
      return { ...c, size: s };
    }));
  }
}

// Read a .glb or .gltf the author picks, weld it, and keep it in the store as
// an imported mesh: `then` is given its name.
function importMesh(then: (name: string) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".glb,.gltf,model/gltf-binary";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), "");
      const verts: [number, number, number][] = [];
      const faces: number[][] = [];
      const index = new Map<string, number>();
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry;
        const pos = g.getAttribute("position");
        const at = (i: number): number => {
          const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld);
          // Welded to a tenth of a millimetre, so a mesh exported with split
          // normals is closed again.
          const key = `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`;
          let k = index.get(key);
          if (k === undefined) {
            k = verts.length;
            index.set(key, k);
            verts.push([p.x, p.y, p.z]);
          }
          return k;
        };
        const idx = g.index;
        const count = idx ? idx.count : pos.count;
        for (let t = 0; t < count; t += 3) {
          const a = at(idx ? idx.getX(t) : t);
          const b = at(idx ? idx.getX(t + 1) : t + 1);
          const c = at(idx ? idx.getX(t + 2) : t + 2);
          if (a !== b && b !== c && a !== c) faces.push([a, b, c]);
        }
      });
      const res = await fetch(MESHES_API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verts, faces }) });
      const body = (await res.json()) as { name?: string; error?: string };
      if (!body.name) throw new Error(body.error ?? `the store answered ${res.status}`);
      then(body.name);
    } catch (e) {
      showToast(`Could not import ${file.name}: ${(e as Error).message}`, "warn");
    }
  });
  input.click();
}
