// A camera path's three corridors - the range, the falloff band's outer edge
// and the release - swept once per rule and kept as Path2Ds.
//
// The sweep (`pathCorridorSweepInto`) holds every sample to the controller's
// own predicate, which is a global projection per sample: tens of milliseconds
// a corridor on the river level's route. The editor and the debug overlay drew
// all three every frame, which was most of the frame. A rule is immutable once
// built (see `CameraRule`), so its corridors are too, and a WeakMap on the rule
// is the whole invalidation story: a new rule is new geometry, and a dropped
// one takes its paths with it.
//
// World coordinates, as the sweep emits them, so a cached path is stroked under
// whatever camera transform the caller has set - the zoom only changes the line
// width and dash, which the caller sets and the path does not carry.

import {
  pathBandAxes,
  pathParamsAt,
  pathRangeAxes,
  pathReleaseAxes,
  type CameraRule,
  type PathParams,
} from "./cameraController";
import { pathCorridorSweepInto } from "./shapePath";

export type CorridorKind = "range" | "band" | "release";

const AXES: Record<CorridorKind, (p: PathParams) => { x: number; y: number }> = {
  range: pathRangeAxes,
  band: pathBandAxes,
  release: pathReleaseAxes,
};

const cache = new WeakMap<CameraRule, Partial<Record<CorridorKind, Path2D>>>();

export function pathCorridor(rule: CameraRule & { kind: "path" }, kind: CorridorKind): Path2D {
  let entry = cache.get(rule);
  if (!entry) {
    entry = {};
    cache.set(rule, entry);
  }
  let path = entry[kind];
  if (!path) {
    path = new Path2D();
    const axes = AXES[kind];
    pathCorridorSweepInto(path, rule.index, (s) => axes(pathParamsAt(rule, s)));
    entry[kind] = path;
  }
  return path;
}
