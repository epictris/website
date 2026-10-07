import * as THREE from "three";
import type { EdItem } from "./model";
import { vineSurfaceSoup, exportHangingVine, glbBase64 } from "./hangingVineTool";
import { LeafLibrary } from "../render3d/foliage/leafLibrary";
import { HANGING_LEAF_PROFILES, LEAF_SETS, LEAF_SHADES } from "../render3d/foliage/vine/hangingLeafProfiles";
import { DEFAULT_HANGING_VINE_SETTINGS, generateHangingVine, applyHangingVineLeafTextures,
  disposeHangingVine, setLeafLibrary, type HangingVineSettings, type HangingVineRecipe,
  type VineObstacle, VineSurface } from "../render3d/foliage/vine/hangingVine";
import { DEFAULT_FERN_SETTINGS, generateFern, disposeFern, varietyDefaults,
  type FernSettings, type FernRecipe, type FernVariety } from "../render3d/foliage/vine/fern";
import { generateHangingVine as generateLegacy, applyHangingVineLeafTextures as textureLegacy,
  disposeHangingVine as disposeLegacy } from "../render3d/hangingVine";
import { findFernSpots } from "../render3d/foliage/fernPlacement";
import { isGeneratedFoliage, type SavedFoliage, type FoliageRecipe } from "../render3d/foliage/recipe";
import { attachFoliageWind, disposeFoliageWind, setFoliageWind, foliageWindSettings } from "../render3d/foliage/wind";
import leafAtlas from "../render3d/foliage/assets/leaves3/leaf-atlas.webp?url";
import fernAtlas from "../render3d/foliage/assets/ferns/fern-atlas.webp?url";
import leafletAtlas from "../render3d/foliage/assets/leaflets/leaflet-atlas.webp?url";
import sprigAtlas from "../render3d/foliage/assets/sprig/sprig.webp?url";
import "./foliageTool.css";

const thumbs = import.meta.glob<string>("../render3d/foliage/assets/leaves3/thumb-*.png", { eager: true, query: "?url", import: "default" });
const defaults: HangingVineSettings = { ...DEFAULT_HANGING_VINE_SETTINGS, leafStyle: LEAF_SETS.painted.join("+"), natural: true, paintTint: 0.6 };
type Draft = { host: EdItem; frame: THREE.Matrix4; recipe: FoliageRecipe; kind: SavedFoliage["kind"]; replace: EdItem | null; ready: boolean };
export type FoliageCommit = { host: EdItem; replace: EdItem | null; frame: THREE.Matrix4; bounds: THREE.Box3; mesh: string };
export interface FoliageContext {
  layer: THREE.Group;
  selected(): EdItem | null;
  host(id: number): EdItem | undefined;
  hosts(item: EdItem): EdItem[];
  plants(item: EdItem): EdItem[];
  meshes(item: EdItem): THREE.Mesh[];
  frame(item: EdItem): THREE.Matrix4;
  revision(): number;
  editable(): boolean;
  pick(screen: { x: number; y: number }): { host: EdItem; point: THREE.Vector3; normal: THREE.Vector3 } | null;
  commit(items: FoliageCommit[]): void;
  activate(kind: "hangingVine" | "fern"): void;
}

export function createFoliageTool(ctx: FoliageContext) {
  const panel = document.createElement("div"); panel.className = "ed-foliage";
  const actions = document.createElement("div"); actions.className = "ed-row";
  const fields = document.createElement("div"); fields.className = "ed-row";
  const advanced = document.createElement("details"); advanced.className = "ed-foliage-advanced";
  const summary = document.createElement("summary"); summary.textContent = "Shape and variation";
  const more = document.createElement("div"); more.className = "ed-row"; advanced.append(summary, more);
  const leafPicker = document.createElement("details"); const leafSummary = document.createElement("summary"); leafSummary.textContent = "Choose individual leaves";
  const leafGrid = document.createElement("div"); leafGrid.className = "ed-foliage-leaves"; leafPicker.append(leafSummary, leafGrid);
  const status = document.createElement("span"); status.className = "ed-root-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  panel.append(actions, fields, advanced, leafPicker, status);
  const preview = new THREE.Group(); preview.name = "Foliage preview"; ctx.layer.add(preview);
  const guide = new THREE.Group();
  const rootMarker = new THREE.Mesh(new THREE.SphereGeometry(.035, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffd15d, depthTest: false }));
  const directionMarker = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), .4, 0xa3e589, .1, .05);
  guide.add(rootMarker, directionMarker); guide.renderOrder = 50; guide.visible = false; ctx.layer.add(guide);
  const suppressed = new Map<THREE.Mesh, boolean>();
  let draft: Draft | null = null, active = "", busy = false, epoch = 0;
  let previewRevision = -1;
  let results: { draft: Draft; group: THREE.Group; obstacles: VineObstacle[]; bounds: THREE.Box3 }[] = [];
  let vineSettings = { ...defaults }, fernSettings = { ...DEFAULT_FERN_SETTINGS };
  const library = new LeafLibrary(leafAtlas);
  let assets: Promise<{ fern: THREE.Texture; leaflet: THREE.Texture; sprig: THREE.Texture }> | undefined;
  async function loadAssets() {
    assets ??= Promise.all([library.init(), ...[fernAtlas, leafletAtlas, sprigAtlas].map(url => new THREE.TextureLoader().loadAsync(url))])
      .then(([, fern, leaflet, sprig]) => {
        for (const texture of [fern, leaflet, sprig]) { texture.colorSpace = THREE.SRGBColorSpace; texture.flipY = false; texture.userData.shared = true; }
        library.texture!.userData.shared = true;
        return { fern, leaflet, sprig };
      }).catch(error => { assets = undefined; throw error; });
    return assets;
  }
  const btn = (label: string, fn: () => void | Promise<void>, parent: HTMLElement = actions) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "ed-btn"; b.textContent = label;
    b.onclick = () => { if (!busy) void Promise.resolve().then(fn).catch(report); }; parent.append(b); return b;
  };
  function report(error: unknown) { status.textContent = error instanceof Error ? error.message : "Plant generation failed."; }
  function release() {
    for (const [mesh, visible] of suppressed) mesh.visible = visible;
    suppressed.clear();
    for (const r of results) {
      preview.remove(r.group);
      disposeFoliageWind(r.group);
      if (r.draft.kind === "fern") disposeFern(r.group);
      else if (r.draft.kind === "legacy-vine") disposeLegacy(r.group);
      else disposeHangingVine(r.group);
    }
    results = []; apply.disabled = true;
  }
  function invalidate() { epoch++; release(); }
  function cancel() { invalidate(); draft = null; guide.visible = false; status.textContent = "Click a surface to start a new plant."; }
  function setBusy(value: boolean) {
    busy = value;
    panel.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, button, select").forEach(input => input.disabled = value);
    apply.disabled = value || !results.length;
  }
  const generate = btn("Preview plant", () => grow());
  const apply = btn("Apply", async () => {
    if (!results.length) return;
    if (!ctx.editable() || previewRevision !== ctx.revision()) throw new Error("The level changed. Preview the plants again.");
    const revision = ctx.revision(), ticket = epoch; setBusy(true);
    try {
      const commits: FoliageCommit[] = [];
      for (const result of results) {
        const d = result.draft;
        const candidates = ctx.hosts(d.host);
        const hostIndex = candidates.findIndex(host => host.id === d.host.id);
        if (hostIndex < 0) throw new Error("The plant's host is missing. Place it again.");
        const exportGroup = result.group.clone(true);
        exportGroup.position.set(0, 0, 0);
        exportGroup.traverse(object => { delete object.userData.foliageWind; });
        const glb = await exportHangingVine(exportGroup);
        // Legacy recipes remain editable through the original save endpoint.
        const saved: SavedFoliage = { version: 2, kind: d.kind, recipe: d.recipe, hostId: d.host.id,
          hostMesh: d.host.visual.mesh, hostIndex, customLeaves: d.kind === "vine" ? library.save() : undefined };
        const response = await fetch(d.kind === "legacy-vine" ? "/api/hanging-vines" : "/api/foliage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(d.kind === "legacy-vine" ? { glb: glbBase64(glb), ...saved } : { glb: glbBase64(glb), saved }),
        });
        const data = await response.json();
        if (!response.ok || !data.mesh) throw new Error(data.error ?? "Could not save plant.");
        commits.push({ host: d.host, replace: d.replace, frame: d.frame, bounds: result.bounds, mesh: data.mesh });
      }
      if (ticket !== epoch || ctx.revision() !== revision || !ctx.editable()) throw new Error("The level changed while saving. Preview again.");
      ctx.commit(commits); const count = commits.length;
      cancel(); status.textContent = `${count === 1 ? "Plant" : `${count} plants`} saved. Select a plant and choose Edit selected plant to revise it.`;
    } finally { setBusy(false); }
  });
  apply.disabled = true;
  btn("Edit selected plant", async () => {
    const item = ctx.selected();
    const id = item?.visual.mesh.match(/^(?:vine-v3|foliage-v1):([a-f0-9-]{36}):/)?.[1];
    if (!item || !id) throw new Error("Select a generated vine or fern first.");
    const ticket = ++epoch, revision = ctx.revision(); setBusy(true);
    try {
      const response = await fetch(`/api/foliage/${id}`); const saved = await response.json();
      if (!response.ok || !saved.recipe) throw new Error(saved.error ?? "This plant has no editable recipe.");
      const candidates = ctx.hosts(item), matching = candidates.filter(host => host.visual.mesh === saved.hostMesh);
      const indexed = candidates[saved.hostIndex];
      const host = indexed?.visual.mesh === saved.hostMesh ? indexed : matching.length === 1 ? matching[0] : undefined;
      if (!host) throw new Error("The original host is missing or ambiguous. Place a new plant on the intended surface.");
      await loadAssets();
      release(); await library.load(saved.customLeaves ?? []); library.texture!.userData.shared = true;
      if (ticket !== epoch || revision !== ctx.revision()) throw new Error("Selection changed. Edit the plant again.");
      const kind: SavedFoliage["kind"] = saved.version === 2 ? saved.kind : "legacy-vine";
      const oldFrame = ctx.frame(item), origin = new THREE.Vector3().setFromMatrixPosition(oldFrame);
      const frame = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z);
      const recipe = structuredClone(saved.recipe) as FoliageRecipe;
      const scale = Math.abs(item.visual.scale);
      if (!Number.isFinite(scale) || scale <= 0) throw new Error("Invalid plant scale.");
      const transformPoint = (p: number[]) => new THREE.Vector3(...p).applyMatrix4(oldFrame).sub(origin).toArray() as [number, number, number];
      recipe.normal = new THREE.Vector3(...recipe.normal).applyMatrix3(new THREE.Matrix3().getNormalMatrix(oldFrame)).normalize().toArray();
      if (kind === "fern") {
        const r = recipe as FernRecipe; r.root = transformPoint(r.root); r.open = new THREE.Vector3(...r.open).transformDirection(oldFrame).toArray();
        r.settings.length *= scale; fernSettings = { ...r.settings };
      } else {
        const r = recipe as HangingVineRecipe; r.start = transformPoint(r.start); r.direction = new THREE.Vector3(...r.direction).transformDirection(oldFrame).toArray();
        for (const key of ["length", "radius", "leafSpacing", "leafSize"] as const) r.settings[key] *= scale;
        vineSettings = { ...r.settings };
      }
      draft = { host, frame, recipe, kind, replace: item, ready: true };
      ctx.activate(kind === "fern" ? "fern" : "hangingVine");
      renderFields(); status.textContent = "Settings loaded. Preview, then Apply to replace this plant.";
    } finally { setBusy(false); }
  });
  btn("New seed", () => { const s = active === "fern" ? fernSettings : vineSettings; s.seed = Math.floor(Math.random() * 2147483647); invalidate(); renderFields(); });
  btn("Reset", () => {
    const seed = active === "fern" ? fernSettings.seed : vineSettings.seed;
    if (active === "fern") fernSettings = { ...DEFAULT_FERN_SETTINGS, ...varietyDefaults(fernSettings.variety), seed };
    else { vineSettings = { ...defaults, seed }; if (draft?.kind === "legacy-vine") draft.kind = "vine"; }
    invalidate(); renderFields();
  });
  btn("Cancel", cancel);
  btn("Re-aim", () => {
    if (!draft) throw new Error("Place or edit a plant first.");
    invalidate(); draft.ready = false;
    status.textContent = "Click a second point on the host to set the direction.";
  });
  let scatterCount = 5, spacing = 0.3;
  const scatterButton = btn("Preview scatter", () => grow(true));
  function labelled(label: string, input: HTMLElement, parent = fields) {
    const wrap = document.createElement("label"); wrap.className = "ed-foliage-field";
    const text = document.createElement("span"); text.textContent = label; wrap.append(text, input); parent.append(wrap);
  }
  function numeric(label: string, value: number, min: number, max: number, step: number, update: (n: number) => void, parent = fields, regenerates = true) {
    const input = document.createElement("input"); input.type = "number"; input.className = "ed-num";
    input.value = String(value); input.min = String(min); input.max = String(max); input.step = String(step);
    input.onchange = () => { if (input.reportValidity()) { if (regenerates) invalidate(); update(input.valueAsNumber); } }; labelled(label, input, parent);
  }
  function checkbox(label: string, checked: boolean, update: (value: boolean) => void, parent = more, regenerates = true) {
    const input = document.createElement("input"); input.type = "checkbox"; input.checked = checked;
    input.onchange = () => { if (regenerates) invalidate(); update(input.checked); }; labelled(label, input, parent);
  }
  function select(label: string, value: string, choices: [string, string][], update: (value: string) => void, parent = fields) {
    const input = document.createElement("select"); input.className = "ed-select";
    for (const [id, text] of choices) { const option = new Option(text, id); input.append(option); }
    if (!choices.some(([id]) => id === value)) input.append(new Option("Custom selection", value));
    input.value = value; input.onchange = () => { invalidate(); update(input.value); }; labelled(label, input, parent);
  }
  function renderLeaves() {
    leafGrid.replaceChildren();
    const chosen = new Set(vineSettings.leafStyle === "mixed" ? HANGING_LEAF_PROFILES.map(p => p.id) : vineSettings.leafStyle.split("+"));
    const leaves = [...HANGING_LEAF_PROFILES.map(p => ({ id: p.id, name: p.id.replace("paint-", "Painted ").replace("leaf-", "Silhouette "),
      thumb: thumbs[`../render3d/foliage/assets/leaves3/thumb-${p.id}.png`] })), ...library.custom];
    for (const leaf of leaves) {
      const b = btn(leaf.name, () => {
        if (chosen.has(leaf.id)) { if (chosen.size <= 1) throw new Error("Keep at least one leaf selected."); chosen.delete(leaf.id); }
        else chosen.add(leaf.id);
        vineSettings.leafStyle = [...chosen].join("+"); invalidate(); renderLeaves();
      }, leafGrid);
      b.setAttribute("aria-pressed", String(chosen.has(leaf.id))); b.title = leaf.name;
      if (leaf.thumb) { const img = document.createElement("img"); img.src = leaf.thumb; img.alt = ""; b.prepend(img); }
      if (leaf.id.startsWith("my-")) btn(`Remove ${leaf.name}`, () => {
        invalidate(); library.remove(leaf.id); library.texture!.userData.shared = true;
        const ids = vineSettings.leafStyle.split("+").filter(id => id !== leaf.id); vineSettings.leafStyle = ids.length ? ids.join("+") : defaults.leafStyle;
        renderLeaves();
      }, leafGrid);
    }
  }
  function renderFields() {
    fields.replaceChildren(); more.replaceChildren();
    const fern = active === "fern"; scatterButton.style.display = fern ? "" : "none"; leafPicker.style.display = fern ? "none" : "";
    generate.textContent = fern ? "Preview fern" : "Preview vine";
    if (fern) {
      select("Variety", fernSettings.variety, [["painted", "Painted fronds"], ["leaflet", "Leaflets on stems"], ["sprig", "Leaf sprigs"]], value => {
        Object.assign(fernSettings, varietyDefaults(value as FernVariety)); renderFields();
      });
      const main: [keyof FernSettings, string, number, number, number][] = [["fronds", "Fronds", 1, 24, 1], ["length", "Length (m)", .05, 3, .05], ["droop", "Droop", 0, 1, .05], ["spread", "Spread (°)", 5, 85, 1]];
      const extra: typeof main = [["lean", "Lean", 0, 1, .05], ["fold", "Midrib fold", 0, 1, .05], ["twist", "Twist", 0, 1, .05], ["croziers", "Fiddleheads", 0, 6, 1], ["lengthVar", "Length variation", 0, 1, .05]];
      if (fernSettings.variety !== "painted") extra.push(["pinnae", "Leaf pairs", 3, 30, 1], ["leafSize", "Leaf size", .3, 2, .05], ["leafCurve", "Leaf curve", 0, 1, .05], ["leafVariation", "Leaf variation", 0, 1, .05]);
      if (fernSettings.variety === "leaflet") {
        extra.push(["leaflets", "Tiny leaves per side", 0, 14, 1]);
        select("Leaf form", fernSettings.leafForm, [["smooth", "Smooth"], ["creased", "Creased"]], value => fernSettings.leafForm = value as "smooth" | "creased", more);
      }
      if (fernSettings.variety !== "painted") checkbox("Mirror pairs", fernSettings.mirrorPairs, value => fernSettings.mirrorPairs = value);
      for (const [key, label, min, max, step] of main) numeric(label, fernSettings[key] as number, min, max, step, value => (fernSettings as unknown as Record<string, unknown>)[key] = value);
      for (const [key, label, min, max, step] of extra) numeric(label, fernSettings[key] as number, min, max, step, value => (fernSettings as unknown as Record<string, unknown>)[key] = value, more);
      numeric("Scatter count", scatterCount, 1, 30, 1, value => scatterCount = value);
      numeric("Crown spacing (m)", spacing, .05, 3, .05, value => spacing = value);
    } else {
      const main: [keyof HangingVineSettings, string, number, number, number][] = [["length", "Length (m)", .05, 30, .1], ["leafSize", "Leaf size (m)", .03, 1, .01], ["leafSpacing", "Leaf gap (m)", .04, 2, .01]];
      const extra: typeof main = [["radius", "Stem radius (m)", .001, .06, .001], ["cling", "Cling", 0, 1, .05], ["bend", "Bend", 0, 1, .05], ["leafAngle", "Leaf spread (°)", 5, 85, 1], ["variation", "Variation", 0, 1, .05]];
      for (const [key, label, min, max, step] of main) numeric(label, vineSettings[key] as number, min, max, step, value => (vineSettings as unknown as Record<string, unknown>)[key] = value);
      for (const [key, label, min, max, step] of extra) numeric(label, vineSettings[key] as number, min, max, step, value => (vineSettings as unknown as Record<string, unknown>)[key] = value, more);
      if (draft?.kind === "legacy-vine") {
        select("Legacy leaf", vineSettings.leafStyle, [["mixed", "Mixed SVG"], ["heart", "Heart"], ["lobed", "Lobed"], ["heart-offset", "Offset heart"]], value => vineSettings.leafStyle = value);
        leafPicker.style.display = "none";
      } else {
        select("Leaves", vineSettings.leafStyle, [[LEAF_SETS.painted.join("+"), "Painted"], [LEAF_SETS.silhouettes.join("+"), "Silhouettes"], ["mixed", "All"]], value => { vineSettings.leafStyle = value; renderLeaves(); });
        checkbox("Natural leaves", vineSettings.natural !== false, value => vineSettings.natural = value);
        const file = document.createElement("input"); file.type = "file"; file.accept = "image/png,image/webp,image/jpeg";
        let keepColour = true;
        checkbox("Keep imported colours", true, value => keepColour = value, more, false);
        file.onchange = async () => {
          if (!file.files?.[0]) return; setBusy(true);
          try { await loadAssets(); invalidate(); const added = await library.importImage(file.files[0], file.files[0].name, keepColour); library.texture!.userData.shared = true;
            vineSettings.leafStyle = added.map(l => l.id).join("+"); renderLeaves(); status.textContent = `${added.length} leaves added. Preview and Apply to save them with this vine.`;
          } catch (error) { report(error); } finally { setBusy(false); }
        };
        labelled("Import leaf image", file, more); renderLeaves();
      }
    }
    const s = fern ? fernSettings : vineSettings;
    numeric("Paint tint", s.paintTint ?? .6, 0, 1, .05, value => s.paintTint = value, more);
    numeric("Seed", s.seed, 0, 2147483647, 1, value => s.seed = value, more);
    const swatches = document.createElement("div"); swatches.className = "ed-foliage-swatches";
    const selected = new Set(s.shades ? s.shades.split("+") : LEAF_SHADES.map(shade => shade.id));
    for (const shade of LEAF_SHADES) {
      const b = btn(shade.name, () => {
        if (selected.has(shade.id)) { if (selected.size === 1) throw new Error("Keep at least one green selected."); selected.delete(shade.id); }
        else selected.add(shade.id);
        s.shades = [...selected].join("+"); invalidate(); renderFields();
      }, swatches);
      b.style.setProperty("--leaf-colour", shade.hex); b.setAttribute("aria-pressed", String(selected.has(shade.id)));
      b.setAttribute("aria-label", shade.name);
    }
    labelled("Greens", swatches, more);
    const wind = foliageWindSettings();
    checkbox("Sway", wind.enabled, value => setFoliageWind(value), more, false);
    numeric("Sway strength", wind.strength, 0, 3, .1, value => setFoliageWind(foliageWindSettings().enabled, value), more, false);
    apply.disabled = !results.length;
  }
  function readRecipe(d: Draft): FoliageRecipe {
    return d.kind === "fern" ? { ...(d.recipe as FernRecipe), settings: { ...fernSettings } } : { ...(d.recipe as HangingVineRecipe), settings: { ...vineSettings } };
  }
  async function grow(scatter = false) {
    if (!ctx.editable()) throw new Error("Wait for the scene to finish updating.");
    let d = draft;
    if (scatter) {
      const selected = ctx.selected(); const host = d?.host ?? (selected && !isGeneratedFoliage(selected.visual.mesh) ? selected : null);
      if (!host || !ctx.meshes(host).length) throw new Error("Select a rock or click its surface before scattering ferns.");
      const origin = new THREE.Vector3().setFromMatrixPosition(ctx.frame(host));
      d = { host, frame: new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z), kind: "fern", replace: null, ready: true,
        recipe: { version: 1, kind: "fern", root: [0, 0, 0], normal: [0, 1, 0], open: [1, 0, 0], settings: { ...fernSettings } } };
    }
    if (!d || !d.ready) throw new Error(active === "fern" ? "Click the host surface to place a fern." : "Click the root, then a second point on the same host for direction.");
    const host = ctx.host(d.host.id);
    if (!host) throw new Error("The original host was removed. Re-place the plant.");
    d = { ...d, host };
    if (d.kind === "fern") {
      const blades = fernSettings.fronds * (fernSettings.variety === "painted" ? 1 : fernSettings.pinnae * 2 * Math.max(1, fernSettings.leaflets * 2));
      if (blades * (scatter ? scatterCount : 1) > 10000) throw new Error("This preview would contain too many leaves. Reduce fronds, leaf pairs, tiny leaves, or scatter count.");
    }
    invalidate(); const ticket = epoch, revision = ctx.revision(); setBusy(true); status.textContent = scatter ? "Finding fern spots…" : "Growing preview…";
    try {
      const textures = await loadAssets();
      if (ticket !== epoch) return;
      const soup = vineSurfaceSoup(ctx.meshes(d.host), d.frame);
      const surface = new VineSurface(soup);
      const avoid: VineObstacle[] = [], existingRoots: THREE.Vector3[] = [];
      for (const item of ctx.plants(d.host).filter(item => item.id !== d!.replace?.id)) {
        const id = item.visual.mesh.split(":")[1];
        const response = await fetch(`/api/foliage/${id}`);
        if (!response.ok) continue;
        const saved = await response.json();
        if (!saved.recipe) continue;
        const toLocal = d.frame.clone().invert().multiply(ctx.frame(item));
        const root = saved.recipe.root ?? saved.recipe.start;
        if (root) existingRoots.push(new THREE.Vector3(...root).applyMatrix4(toLocal));
        // Sample existing rendered plants for conservative nearby-plant clearance.
        for (const mesh of ctx.meshes(item)) {
          mesh.updateWorldMatrix(true, false);
          const positions = mesh.geometry.getAttribute("position"), transform = d.frame.clone().invert().multiply(mesh.matrixWorld);
          if (!positions) continue;
          const stride = Math.max(1, Math.ceil(positions.count / 180));
          for (let i = 0; i < positions.count; i += stride) avoid.push({ centre: new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(transform), radius: .018 });
        }
      }
      const drafts: Draft[] = scatter ? findFernSpots(surface, soup, fernSettings, existingRoots, scatterCount, spacing, fernSettings.seed).map((spot, i) => ({ ...d!,
        recipe: { version: 1, kind: "fern", root: spot.point.toArray(), normal: spot.normal.toArray(), open: spot.open.toArray(), settings: { ...fernSettings, seed: (fernSettings.seed + i * 97) % 2147483648 } } })) : [{ ...d, recipe: readRecipe(d) }];
      let vertices = 0;
      for (const input of drafts) {
        if (ticket !== epoch || revision !== ctx.revision()) throw new Error("The level changed. Preview again.");
        let group: THREE.Group, obstacles: VineObstacle[] = [];
        if (input.kind === "fern") {
          const result = generateFern(surface, input.recipe as FernRecipe, { texture: textures.fern, leafletTexture: textures.leaflet, sprigTexture: textures.sprig, avoid });
          group = result.group; obstacles = result.obstacles;
        } else if (input.kind === "legacy-vine") {
          const result = generateLegacy(soup, input.recipe as HangingVineRecipe); group = result.group;
          results.push({ draft: input, group, obstacles, bounds: new THREE.Box3().setFromObject(group) });
          await textureLegacy(group); results.pop();
        } else {
          setLeafLibrary(library.profiles);
          let result;
          try { result = generateHangingVine(soup, input.recipe as HangingVineRecipe, { avoid }); }
          finally { setLeafLibrary(HANGING_LEAF_PROFILES); }
          group = result.group; obstacles = result.obstacles;
          results.push({ draft: input, group, obstacles, bounds: new THREE.Box3().setFromObject(group) });
          await applyHangingVineLeafTextures(group, { texture: library.texture! }); results.pop();
        }
        const bounds = new THREE.Box3().setFromObject(group);
        results.push({ draft: input, group, obstacles, bounds }); avoid.push(...obstacles);
        group.traverse(object => { if (object instanceof THREE.Mesh) vertices += object.geometry.getAttribute("position").count; });
        if (vertices > 600000) throw new Error("This preview is too detailed. Reduce the scatter count or plant detail.");
        attachFoliageWind(group, false); group.position.setFromMatrixPosition(input.frame); preview.add(group);
        if (input.replace) for (const mesh of ctx.meshes(input.replace)) {
          suppressed.set(mesh, mesh.visible); mesh.visible = false;
        }
        if (drafts.length > 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      if (ticket !== epoch || revision !== ctx.revision()) throw new Error("The level changed. Preview again.");
      previewRevision = revision;
      status.textContent = scatter ? `${results.length} of ${scatterCount} suitable fern placements. Apply saves the batch; Cancel discards it.` : "Preview ready. Apply saves this plant; Cancel discards it.";
    } catch (error) { release(); throw error; }
    finally { setBusy(false); }
  }
  function click(screen: { x: number; y: number }) {
    if (busy) return;
    const hit = ctx.pick(screen);
    if (!hit) { status.textContent = "Click a rock or another visible model surface."; return; }
    invalidate();
    if (active === "fern") {
      if (draft?.kind === "fern" && draft.host.id === hit.host.id) {
        const r = draft.recipe as FernRecipe;
        const root = new THREE.Vector3(...r.root).applyMatrix4(draft.frame);
        const open = hit.point.clone().sub(root).projectOnPlane(new THREE.Vector3(...r.normal));
        if (open.length() < .05) { status.textContent = "Choose an opening direction at least 5 cm from the crown."; return; }
        r.open = open.normalize().toArray(); draft.ready = true;
        status.textContent = "Opening direction set. Preview fern to check its shape."; return;
      }
      const frame = new THREE.Matrix4().makeTranslation(...hit.point.toArray());
      const open = new THREE.Vector3(1, 0, 0).projectOnPlane(hit.normal);
      if (open.lengthSq() < .001) open.set(0, 0, 1).projectOnPlane(hit.normal);
      draft = { host: hit.host, frame, kind: "fern", replace: null, ready: true, recipe: { version: 1, kind: "fern", root: [0, 0, 0], normal: hit.normal.toArray(), open: open.normalize().toArray(), settings: { ...fernSettings } } };
      status.textContent = "Fern crown placed. Click a second point to aim its opening, or Preview fern.";
      // Subsequent clicks on the same host aim the crown until Re-place is chosen.
    } else if (draft && !draft.ready && draft.host.id === hit.host.id) {
      const direction = hit.point.clone().sub(new THREE.Vector3().setFromMatrixPosition(draft.frame));
      if (direction.length() < .05) { status.textContent = "Choose a direction at least 5 cm from the root."; return; }
      (draft.recipe as HangingVineRecipe).direction = direction.normalize().toArray(); draft.ready = true;
      status.textContent = "Direction set. Preview vine to grow it over the surface.";
    } else {
      draft = { host: hit.host, frame: new THREE.Matrix4().makeTranslation(...hit.point.toArray()), kind: "vine", replace: null, ready: false,
        recipe: { version: 1, start: [0, 0, 0], normal: hit.normal.toArray(), direction: [1, 0, 0], settings: { ...vineSettings } } };
      status.textContent = "Click a second point on the same host to set the crawl direction.";
    }
  }
  function refresh(tool: string, visible: boolean) {
    const kind = tool === "fern" ? "fern" : tool === "hangingVine" ? "hangingVine" : "";
    if (kind !== active) {
      // Editing deliberately activates the appropriate tool after loading a draft.
      if (draft && ((draft.kind === "fern") !== (kind === "fern") || !kind)) cancel();
      active = kind; renderFields();
      if (!draft && !results.length && kind) status.textContent = kind === "fern"
        ? "Click a surface for a fern, or select a host and Preview scatter."
        : "Click a root, then a crawl direction on the same host.";
    }
    panel.style.display = kind ? "" : "none"; preview.visible = !!kind && visible;
    guide.visible = !!draft && !!kind && visible;
    if (draft) {
      const r = draft.recipe;
      rootMarker.position.copy(new THREE.Vector3(...("root" in r ? r.root : r.start)).applyMatrix4(draft.frame));
      directionMarker.position.copy(rootMarker.position);
      directionMarker.setDirection(new THREE.Vector3(...("open" in r ? r.open : r.direction)).normalize());
      directionMarker.visible = draft.ready;
    }
    if (results.length && previewRevision !== ctx.revision() && !busy) { invalidate(); status.textContent = "The level changed. Preview again."; }
  }
  btn("Re-place", () => { cancel(); status.textContent = "Click the new root on the host surface."; });
  return { panel, click, refresh, cancel, hasDraft: () => !!draft || !!results.length };
}
