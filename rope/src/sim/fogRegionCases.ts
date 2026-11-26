import * as THREE from "three";
import { modelFromDisk, modelToFlatDisk } from "../editor/model";
import { PX } from "../engine/units";
import { scaleLevelData, type EnvironmentData, type FogRegionData, type RawLevelData } from "../level/levelFormat";
import { AVATAR_FOG, avatarFogChunk } from "../render3d/avatarSurface";
import { FOG_MIX } from "../render3d/editorFog";
import { Environment, FOG_REFERENCE_DISTANCE, fogDensity } from "../render3d/environment";
import {
  fogRegionFog,
  fogRegionState,
  fogRegionUniforms,
  fogRegionWeight,
  REGION_FOG_GLSL,
  setFogRegions,
  setFogRegionsShown,
  type RegionAir,
} from "../render3d/fogRegions";
import type { CaseResult } from "./render3dCases";

// Region i's air as every shader reads it: the third texel of its row (the
// working-space colour and the density), and the fourth (the colour in the
// screen's space, what a program drawing to the canvas mixes).
function texelAir(i: number): number[] {
  const data = fogRegionState().data.image.data as Float32Array;
  return Array.from(data.subarray(i * 16 + 8, i * 16 + 12));
}
function texelScreen(i: number): number[] {
  const data = fogRegionState().data.image.data as Float32Array;
  return Array.from(data.subarray(i * 16 + 12, i * 16 + 15));
}

// The air as `regionAirOf` resolves it, rounded to the float32 the texture holds.
function f32(color: THREE.Color, density: number): number[] {
  return [color.r, color.g, color.b, density].map(Math.fround);
}

// What three's `refreshFogUniforms` hands a program drawing to the canvas as
// `fogColor` (`getRGB` into the renderer's output space, sRGB), as float32s.
function uniformOnScreen(color: THREE.Color): number[] {
  const c = color.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b].map(Math.fround);
}

export function fogRegionCases(): CaseResult[] {
  const region: FogRegionData = { x: 10, y: -5, rot: 0, shape: { kind: "rect", w: 20, h: 10 }, falloff: 2 };
  const values = [fogRegionWeight([region], 10, -5), fogRegionWeight([region], 19, -5),
    fogRegionWeight([region], 20, -5), fogRegionWeight([region], 21, -5)];
  const circle: FogRegionData = { x: 0, y: 0, rot: 0, shape: { kind: "circle", r: 5 }, falloff: 2 };
  const turned = { ...region, rot: Math.PI / 2 };
  const disk: RawLevelData = { player: { x: 0, y: 0, radius: 20 }, bodies: [], fogRegions: [
    { x: 1000, y: -500, rot: .3, shape: { kind: "rect", w: 2000, h: 1000 }, falloff: 200, amount: .4, color: "#336699" },
    { x: 0, y: 0, rot: 0, shape: { kind: "circle", r: 500 } },
  ] };
  const metres = scaleLevelData(disk, PX).fogRegions!;
  const model = modelFromDisk(disk);
  const back = modelToFlatDisk(model).fogRegions!;
  const roundtrip = JSON.stringify(back) === JSON.stringify(disk.fogRegions);
  model.items = model.items.filter((i) => i.object !== "fog");
  const deleted = modelToFlatDisk(model).fogRegions;
  const absent = modelToFlatDisk(modelFromDisk({ player: disk.player, bodies: [] })).fogRegions;
  const shared = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]).fogRegions?.value;
  setFogRegions([region]);
  const observes = shared === fogRegionUniforms().fogRegions?.value && shared.count === 1 && shared.enabled === 1;
  setFogRegions([]);
  const empty = shared.count === 0 && shared.enabled === 1;
  setFogRegions(undefined);

  // THE REGIONS' OWN AIR, through the `Environment` the game builds, against
  // the river's level-wide fog (ball.json before its regions owned it).
  const river: EnvironmentData = { fogAmount: 0.52, fogColor: "#2a5075" };
  const scene = new THREE.Scene();
  const fogOf = (): THREE.FogExp2 | null => scene.fog as THREE.FogExp2 | null;

  // (1) A region's own amount and colour are what its texel carries and what
  // its pixels get: the authored fraction at the reference distance, its own
  // colour outright.
  const own: FogRegionData = { ...region, amount: 0.3, color: "#884422" };
  let env = new Environment(scene, river, undefined, [own]);
  const ownAir = f32(new THREE.Color("#884422"), fogDensity(0.3));
  const ownTexel = texelAir(0);
  const ownAt = env.regionAir()!;
  const ownPixel = fogRegionFog(ownAt.regions, ownAt.air, 10, -5, FOG_REFERENCE_DISTANCE);
  const ownOk = ownTexel.join() === ownAir.join() && texelScreen(0).join() === uniformOnScreen(new THREE.Color("#884422")).join() &&
    Math.abs(ownPixel.factor - 0.3) < 1e-12 &&
    ownPixel.tint?.getHexString() === "884422" && fogOf()?.color.getHexString() === "884422" &&
    fogOf()?.density === fogDensity(0.3);
  const ownFogHex = fogOf()?.color.getHexString();
  env.dispose();

  // (2) A region authoring neither falls back to the level-wide fog, and is
  // then exactly the old global fog masked by its edge: its texel holds the
  // float32s `scene.fog`'s uniforms would, and `scene.fog` is the old one.
  env = new Environment(scene, river, undefined, [region]);
  const legacyColor = new THREE.Color("#2a5075");
  const fallbackTexel = texelAir(0);
  const fallbackFog = fogOf();
  const sameUniform = fallbackTexel.join() === f32(fallbackFog!.color, fallbackFog!.density).join() &&
    texelScreen(0).join() === uniformOnScreen(fallbackFog!.color).join() &&
    texelScreen(0).join() !== fallbackTexel.slice(0, 3).join();
  const fallbackAt = env.regionAir()!;
  const law = (d: number): number => 1 - Math.exp(-fogDensity(0.52) * fogDensity(0.52) * d * d);
  const masked = [[10, -5, 1], [19, -5, 0.5], [21, -5, 0]].every(([x, y, w]) => {
    const got = fogRegionFog(fallbackAt.regions, fallbackAt.air, x!, y!, 12);
    return got.factor === w! * law(12) && (w === 0 ? got.tint === null : got.tint?.equals(legacyColor) === true);
  });
  const fallbackOk = sameUniform && masked && fallbackFog?.color.equals(legacyColor) === true &&
    fallbackFog.density === fogDensity(0.52) && fogRegionState().enabled === 1;
  env.dispose();

  // (3) Fog is on when only the regions carry an amount (the format-4 level:
  // no level-wide fog at all), off when none has any, and the level-wide fog
  // alone when no regions are authored. The editor's toggle holds both kinds.
  env = new Environment(scene, {}, undefined, [{ ...region, amount: 0.2 }, { ...circle, amount: 0.45 }]);
  const regionOnly = fogOf() instanceof THREE.FogExp2 && fogOf()!.density === fogDensity(0.45) &&
    texelAir(0)[3] === Math.fround(fogDensity(0.2)) && texelAir(0).slice(0, 3).join() === f32(new THREE.Color("#1f2430"), 0).slice(0, 3).join();
  const fogObject = fogOf();
  env.setFogShown(false);
  const hidden = fogOf() === fogObject && fogObject!.density === 0 && fogRegionState().shown === 0;
  env.setFogShown(true);
  const shownAgain = fogObject!.density === fogDensity(0.45) && fogRegionState().shown === 1;
  env.setFogRegions([{ ...region, amount: 0.1 }]);
  const inPlace = fogOf() === fogObject && fogObject!.density === fogDensity(0.1);
  env.setFogRegions([region]);
  const noneLeft = fogOf() === null;
  env.dispose();
  env = new Environment(scene, { fogAmount: 0.25 });
  const legacy = fogOf()?.density === fogDensity(0.25) && fogRegionState().enabled === 0 && env.regionAir() === null;
  env.dispose();
  env = new Environment(scene, river, undefined, []);
  const emptyMask = fogOf() === null && fogRegionState().enabled === 1 && fogRegionState().count === 0;
  env.dispose();
  const enabledOk = regionOnly && hidden && shownAgain && inPlace && noneLeft && legacy && emptyMask;

  // (4) Overlaps take the thickest region, never the sum, tinted by each in
  // proportion to what it gives; outside the overlap each region is its own.
  const thin: FogRegionData = { x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 20, h: 20 }, falloff: 0, amount: 0.2, color: "#ff0000" };
  const thick: FogRegionData = { x: 10, y: 0, rot: 0, shape: { kind: "rect", w: 20, h: 20 }, falloff: 0, amount: 0.6, color: "#0000ff" };
  const air: RegionAir[] = [thin, thick].map((r) => ({ color: new THREE.Color(r.color), density: fogDensity(r.amount!) }));
  const both = fogRegionFog([thin, thick], air, 5, 0, FOG_REFERENCE_DISTANCE);
  const fThin = 0.2, fThick = 0.6;
  const mean = new THREE.Color("#ff0000").multiplyScalar(fThin / (fThin + fThick))
    .add(new THREE.Color("#0000ff").multiplyScalar(fThick / (fThin + fThick)));
  const near = (a: THREE.Color | null, b: THREE.Color): boolean =>
    a !== null && Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 1e-9;
  const onlyThin = fogRegionFog([thin, thick], air, -5, 0, FOG_REFERENCE_DISTANCE);
  const onlyThick = fogRegionFog([thin, thick], air, 15, 0, FOG_REFERENCE_DISTANCE);
  const overlapOk = Math.abs(both.factor - fThick) < 1e-12 && near(both.tint, mean) &&
    Math.abs(onlyThin.factor - fThin) < 1e-12 && near(onlyThin.tint, new THREE.Color("#ff0000")) &&
    Math.abs(onlyThick.factor - fThick) < 1e-12 && near(onlyThick.tint, new THREE.Color("#0000ff"));
  // ...and the shader says the same: the max of each region's own exp2 law
  // times its edge, a running f-weighted mean for the tint (so one region is
  // its colour bit for bit), and every fogged surface mixing toward it -
  // three's chunk, the avatar's and the glass's patches of it.
  const shaderOk = REGION_FOG_GLSL.includes("float f = w * ( 1.0 - exp( - density * density * depth * depth ) );") &&
    REGION_FOG_GLSL.includes("factor = max( factor, f );") &&
    REGION_FOG_GLSL.includes("tint = total > 0.0 ? mix( tint, colour, f / ( total + f ) ) : colour;") &&
    THREE.ShaderChunk.fog_pars_fragment.includes("regionFog( regionFogPoint( cameraPosition, vFogWorldPosition ), d, fogRegionColours(), tint )") &&
    THREE.ShaderChunk.fog_fragment.includes(FOG_MIX) && FOG_MIX.includes("fogTint") &&
    avatarFogChunk().includes(`mix( gl_FragColor.rgb, fogTint, fogFactor * ${AVATAR_FOG} )`);

  setFogRegions(undefined);
  setFogRegionsShown(true);
  return [
    { name: "fog regions: full core, smooth half fade, clear boundary and exterior", pass: values.join() === "1,0.5,0,0", detail: values.join() },
    { name: "fog regions: rotation, circles and overlaps preserve the same edge fade", pass:
      fogRegionWeight([turned], 10, 4) === .5 && fogRegionWeight([circle], 4, 0) === .5 &&
      fogRegionWeight([region, region], 19, -5) === .5 && fogRegionWeight([{ ...region, falloff: 0 }], 19.99, -5) === 1,
      detail: "a rotated rectangle, circular distance, max union and a hard edge" },
    { name: "fog regions: an empty mask is clear; deleting the last region in the editor leaves none, as a level without regions has", pass:
      fogRegionWeight([], 0, 0) === 0 && deleted === undefined && absent === undefined,
      detail: `deleted ${JSON.stringify(deleted)}, absent ${String(absent)}` },
    { name: "fog regions: placement, size, falloff, amount and colour cross pixels/metres and the editor round trip", pass:
      metres[0]!.x === 10 && metres[0]!.falloff === 2 && metres[0]!.shape.kind === "rect" && metres[0]!.shape.w === 20 &&
      metres[0]!.rot === .3 && metres[0]!.amount === .4 && metres[0]!.color === "#336699" &&
      metres[1]!.falloff === undefined && metres[1]!.amount === undefined && roundtrip,
      detail: JSON.stringify(back) },
    { name: "fog regions: existing material uniforms observe edits and clearing the mask", pass: observes && empty && shared.enabled === 0,
      detail: `shared ${observes}; empty ${empty}; reset ${shared.enabled}` },
    { name: "fog regions: a region's own amount and colour are what its texel holds and its pixels get", pass: ownOk,
      detail: `texel ${ownTexel.join()} (want ${ownAir.join()}), factor ${ownPixel.factor} at ${FOG_REFERENCE_DISTANCE} m, tint #${ownPixel.tint?.getHexString()}, scene.fog #${ownFogHex}` },
    { name: "fog regions: a region with no air of its own is the level-wide fog, the same float32s scene.fog's uniforms carry, masked by its edge", pass: fallbackOk,
      detail: `same uniform ${sameUniform}, masked ${masked}, texel ${fallbackTexel.join()}` },
    { name: "fog regions: fog is on when only regions carry an amount, changed in place, off when none has any; the editor toggle hides both kinds", pass: enabledOk,
      detail: `region only ${regionOnly}, hidden ${hidden}, shown ${shownAgain}, in place ${inPlace}, none left ${noneLeft}, legacy ${legacy}, empty mask ${emptyMask}` },
    { name: "fog regions: an overlap takes the thickest region's factor and the f-weighted tint; the shader and every fog mix agree", pass: overlapOk && shaderOk,
      detail: `overlap ${both.factor.toFixed(4)} #${both.tint?.getHexString()} (want ${fThick}, #${mean.getHexString()}); thin ${onlyThin.factor.toFixed(4)}, thick ${onlyThick.factor.toFixed(4)}; shader ${shaderOk}` },
  ];
}
