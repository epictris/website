import * as THREE from "three";
import { modelFromDisk, modelToFlatDisk } from "../editor/model";
import { PX } from "../engine/units";
import { scaleLevelData, type FogRegionData, type RawLevelData } from "../level/levelFormat";
import { fogRegionUniforms, fogRegionWeight, setFogRegions } from "../render3d/fogRegions";
import type { CaseResult } from "./render3dCases";

export function fogRegionCases(): CaseResult[] {
  const region: FogRegionData = { x: 10, y: -5, rot: 0, shape: { kind: "rect", w: 20, h: 10 }, falloff: 2 };
  const values = [fogRegionWeight([region], 10, -5), fogRegionWeight([region], 19, -5),
    fogRegionWeight([region], 20, -5), fogRegionWeight([region], 21, -5)];
  const circle: FogRegionData = { x: 0, y: 0, rot: 0, shape: { kind: "circle", r: 5 }, falloff: 2 };
  const turned = { ...region, rot: Math.PI / 2 };
  const disk: RawLevelData = { player: { x: 0, y: 0, radius: 20 }, bodies: [], fogRegions: [
    { x: 1000, y: -500, rot: .3, shape: { kind: "rect", w: 2000, h: 1000 }, falloff: 200 },
    { x: 0, y: 0, rot: 0, shape: { kind: "circle", r: 500 } },
  ] };
  const metres = scaleLevelData(disk, PX).fogRegions!;
  const model = modelFromDisk(disk);
  const back = modelToFlatDisk(model).fogRegions!;
  const roundtrip = JSON.stringify(back) === JSON.stringify(disk.fogRegions);
  model.items = model.items.filter((i) => i.layer !== "fog");
  const deleted = modelToFlatDisk(model).fogRegions;
  const absent = modelToFlatDisk(modelFromDisk({ player: disk.player, bodies: [] })).fogRegions;
  const shared = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]).fogRegions?.value;
  setFogRegions([region]);
  const observes = shared === fogRegionUniforms().fogRegions?.value && shared.count === 1 && shared.enabled === 1;
  setFogRegions([]);
  const empty = shared.count === 0 && shared.enabled === 1;
  setFogRegions(undefined);
  return [
    { name: "fog regions: full core, smooth half fade, clear boundary and exterior", pass: values.join() === "1,0.5,0,0", detail: values.join() },
    { name: "fog regions: rotation, circles and overlaps preserve the same edge fade", pass:
      fogRegionWeight([turned], 10, 4) === .5 && fogRegionWeight([circle], 4, 0) === .5 &&
      fogRegionWeight([region, region], 19, -5) === .5 && fogRegionWeight([{ ...region, falloff: 0 }], 19.99, -5) === 1,
      detail: "a rotated rectangle, circular distance, max union and a hard edge" },
    { name: "fog regions: absent is global; an empty mask and deleting its last region stay clear", pass:
      fogRegionWeight(undefined, 0, 0) === 1 && fogRegionWeight([], 0, 0) === 0 && deleted?.length === 0 && absent === undefined,
      detail: `deleted ${JSON.stringify(deleted)}, absent ${String(absent)}` },
    { name: "fog regions: placement, size and falloff cross pixels/metres and the editor round trip", pass:
      metres[0]!.x === 10 && metres[0]!.falloff === 2 && metres[0]!.shape.kind === "rect" && metres[0]!.shape.w === 20 &&
      metres[0]!.rot === .3 && metres[1]!.falloff === undefined && roundtrip,
      detail: JSON.stringify(back) },
    { name: "fog regions: existing material uniforms observe edits and clearing the mask", pass: observes && empty && shared.enabled === 0,
      detail: `shared ${observes}; empty ${empty}; reset ${shared.enabled}` },
  ];
}
