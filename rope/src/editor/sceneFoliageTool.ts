import * as THREE from "three";
import { createFoliageTool, type EdItem } from "./foliageTool";
import { plantMeshes, type SceneFoliage, type ScenePlantData, type PlantSurface } from "../render3d/foliageScene";

export function createSceneFoliageTool(ctx: {
  scene: SceneFoliage; layer: THREE.Group; camera: THREE.Camera;
  ndc(screen: { x: number; y: number }): readonly number[] | null;
  revision(): number; editable(): boolean;
  records(): readonly ScenePlantData[];
  commit(records: ScenePlantData[]): void;
  activate(kind: "hangingVine" | "fern"): void;
}) {
  let chosen: number | null = null;
  const ray = new THREE.Raycaster();
  const find = (item: EdItem) => ctx.scene.surfaces.find(host => host.id === item.id) ?? ctx.scene.plants.get(item.id);
  const owner = (item: EdItem) => ctx.scene.surfaces.find(host => host.key === find(item)?.key);
  const tool = createFoliageTool({
    layer: ctx.layer, revision: ctx.revision, editable: ctx.editable, activate: ctx.activate,
    selected: () => ctx.scene.plants.get(chosen ?? -1) ?? ctx.scene.surfaces.find(host => host.id === chosen) ?? null,
    host: id => ctx.scene.surfaces.find(host => host.id === id),
    hosts: item => { const host = owner(item); return host ? [host] : []; },
    plants: item => [...ctx.scene.plants.values()].filter(plant => plant.key === find(item)?.key),
    meshes: item => { const surface = find(item); return surface ? (ctx.scene.plants.has(item.id) ? ctx.scene.meshes(surface) : plantMeshes(surface.root)) : []; },
    frame: item => { const surface = find(item); if (!surface) return new THREE.Matrix4(); surface.root.updateWorldMatrix(true, false); return surface.root.matrixWorld.clone(); },
    pick: screen => {
      const ndc = ctx.ndc(screen); if (!ndc) return null;
      ray.setFromCamera(new THREE.Vector2(ndc[0], ndc[1]), ctx.camera);
      const surfaces = ctx.scene.surfaces;
      const meshHosts = new Map<THREE.Object3D, PlantSurface>();
      for (const host of surfaces) for (const mesh of plantMeshes(host.root)) meshHosts.set(mesh, host);
      const hit = ray.intersectObjects([...meshHosts.keys()], false)[0];
      if (!hit?.face) return null;
      const host = meshHosts.get(hit.object)!; chosen = host.id;
      return { host, point: hit.point, normal: hit.face.normal.clone().transformDirection(hit.object.matrixWorld) };
    },
    commit: items => {
      const records = ctx.records().map(record => ({ ...record, transform: [...record.transform] }));
      let next = Math.max(1000000000, ...records.map(record => record.id)) + 1;
      for (const item of items) {
        const host = find(item.host); if (!host) throw new Error("The plant host is no longer available.");
        host.root.updateWorldMatrix(true, false);
        const record: ScenePlantData = { id: item.replace?.id ?? next++, host: host.key, mesh: item.mesh,
          transform: host.root.matrixWorld.clone().invert().multiply(item.frame).toArray() };
        const previous = records.findIndex(saved => saved.id === record.id);
        if (previous < 0) records.push(record); else records[previous] = record;
        chosen = record.id;
      }
      ctx.commit(records);
    },
  });
  const row = document.createElement("div"); row.className = "ed-row";
  const selection = document.createElement("select"); selection.className = "ed-select"; selection.setAttribute("aria-label", "Plant or host");
  selection.onchange = () => { chosen = selection.value ? Number(selection.value) : null; tool.cancel(); };
  const remove = document.createElement("button"); remove.className = "ed-btn"; remove.textContent = "Remove selected plant";
  remove.onclick = () => { if (ctx.scene.plants.has(chosen ?? -1) && ctx.editable()) { tool.cancel(); ctx.commit(ctx.records().filter(plant => plant.id !== chosen)); chosen = null; } };
  row.append(selection, remove); tool.panel.prepend(row);
  let optionsKey = "";
  return {
    ...tool,
    refresh(active: string, visible: boolean) {
      const entries = [...ctx.scene.surfaces, ...ctx.scene.plants.values()];
      const key = entries.map(item => `${item.id}:${item.visual.mesh}`).join("|");
      if (key !== optionsKey) {
        optionsKey = key; selection.replaceChildren(new Option("Choose a host or saved plant…", ""));
        for (const item of entries) selection.add(new Option(ctx.scene.plants.has(item.id) ? `Plant ${item.id - 1000000000} on ${item.key}` : item.key.replace(/^(body|scene):/, ""), String(item.id)));
      }
      selection.value = chosen === null ? "" : String(chosen);
      remove.disabled = !ctx.scene.plants.has(chosen ?? -1) || !ctx.editable();
      tool.refresh(active, visible);
    },
  };
}
