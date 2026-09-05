// Camera-path geometry cases (src/render/cameraPath.ts), run by `cli camera`.
//
// The camera path is authored geometry that decides where the screen looks, so
// a wrong answer here is not a crash but a camera that leads the player the
// wrong way, or lurches, in a level someone then re-tunes around the lurch.
// The functions are pure, so they are asserted directly rather than through a
// level or a running camera.
//
// The load-bearing case is `switchback-window`. A path that doubles back passes
// within a metre of itself, so the GLOBAL closest point flips branches the
// instant the player is nearer the other one - many metres of arc length in one
// frame, and the lookahead target with it. The windowed projection is the whole
// answer to that, and a window-ignoring implementation passes every other case
// here.

import { Vec2 } from "../engine/vec2";
import type { Camera } from "../render/camera";
import {
  buildCameraRules,
  CAMERA_EDGE_MARGIN,
  CameraController,
  edgeReach,
  pathBand,
  pathFalloffWeight,
  pathRange,
  pathRelease,
  cameraRuleTarget,
  activeCameraRule,
  pathParamsAt,
  pathParamsOf,
  pathRangeAxes,
  type CameraRule,
} from "../render/cameraController";
import type { CameraPathData, CameraRegionData, RawLevelData } from "../level/levelFormat";
import { scaleLevelData } from "../level/levelFormat";
import { modelFromDisk, modelToDisk, reversePathVerts } from "../editor/model";
import { pathCorridorSweepInto } from "../render/shapePath";
import {
  buildPolylineIndex,
  cubicAt,
  flattenPath,
  flattenPathNodes,
  pathNodesOf,
  type PathNode,
  pointAtArcLength,
  projectOntoPolyline,
  projectOntoPolylineWindow,
  type PolylineIndex,
} from "../render/cameraPath";

const V = (x: number, y: number): Vec2 => new Vec2(x, y);

// Metres. Everything here is exact geometry on round numbers, so the tolerance
// only has to cover the float error of a dot product and a square root.
const EPSILON = 1e-9;

export interface CameraResult {
  name: string;
  passed: boolean;
  details: string[];
}

// A case is a named list of assertions, so one failure names the assertion that
// failed rather than the whole file.
interface Check {
  label: string;
  got: number;
  want: number;
  tol?: number;
}

// A case whose answers are not numbers: it returns its complaints directly, and
// no complaints is a pass.
function runFacts(name: string, facts: () => string[]): CameraResult {
  const details = facts();
  return { name, passed: details.length === 0, details };
}

function run(name: string, checks: () => Check[]): CameraResult {
  const details: string[] = [];
  for (const c of checks()) {
    const tol = c.tol ?? EPSILON;
    if (!Number.isFinite(c.got) || Math.abs(c.got - c.want) > tol) {
      details.push(`${c.label}: got ${c.got}, want ${c.want} (±${tol})`);
    }
  }
  return { name, passed: details.length === 0, details };
}

// A single 10 m segment along +x.
const SEGMENT = buildPolylineIndex([V(0, 0), V(10, 0)]);

// An L: 10 m along +x, then 5 m along +y (y is down, as everywhere in this
// engine). The corner at s = 10 is the tie every projection has to agree about.
const ELL = buildPolylineIndex([V(0, 0), V(10, 0), V(10, 5)]);

// A switchback: out along y = 0, a 2 m step down, and back along y = 2. The two
// long branches are 2 m apart, so a player who falls off the upper one is
// nearer the lower one long before they are far from the path.
//
//   s: 0 ───────────► 10 ▼ 12 ◄─────────── 22
const SWITCHBACK = buildPolylineIndex([V(0, 0), V(10, 0), V(10, 2), V(0, 2)]);

function project(ix: PolylineIndex, p: Vec2): { s: number; dist: number } {
  return projectOntoPolyline(ix, p);
}

// A camera the controller can write into. The controller is the only thing
// under test here, so the viewport is whatever - nothing reads it.
function stubCamera(): Camera {
  return { position: Vec2.ZERO, zoom: 1, viewportWidth: 1920, viewportHeight: 1080 };
}

// The straight 10 m path every controller case rides, running along y = 0 with
// a 2.5 m lookahead and a 1 m corridor, so the expected target is arithmetic.
const RIDE: CameraPathData = {
  x: 0,
  y: 0,
  rot: 0,
  verts: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ],
  // Circular on purpose, so the cases about ACQUIRING and RELEASING are not
  // also cases about the ellipse; `range-and-falloff-are-per-axis` and
  // `acquisition-is-screen-shaped` are where the pairs are asserted.
  rangeX: 1,
  rangeY: 1,
  // No falloff band either, so those same cases are about the range and its
  // jitter buffer alone; `falloff-holds-then-releases` is where the band's own
  // effect on the distances is asserted.
  falloffX: 0,
  falloffY: 0,
  // Equal on both axes, so the cases about LEADING are not also cases about the
  // ellipse; `rule-path-lookahead-is-per-axis` is where that is asserted.
  lookaheadX: 2.5,
  lookaheadY: 2.5,
};

// A room the player falls into when the path lets go: a 4 x 4 rect centred
// below the path's midpoint, pinning the camera so the hand-off is unmistakable.
const ROOM: CameraRegionData = {
  x: 5,
  y: 4,
  rot: 0,
  shape: { kind: "rect", w: 4, h: 4 },
  lockX: 5,
  lockY: 4,
};

const BASE_ZOOM = 2;
const DT = 1 / 60;

// Run the controller over a scripted walk, one entry per frame, and answer the
// camera's aim point and the rule in force at each.
function ride(
  rules: readonly CameraRule[],
  walk: readonly Vec2[],
  edgeClamp = true,
): {
  pos: Vec2;
  zoom: number;
  rule: CameraRule | null;
  s: number;
  leadS: number;
  edge: { centre: Vec2; reach: Vec2 } | null;
}[] {
  const ctl = new CameraController();
  ctl.edgeClamp = edgeClamp;
  const cam = stubCamera();
  return walk.map((p) => {
    ctl.update(cam, DT, p, rules, BASE_ZOOM);
    const held = ctl.held;
    return {
      pos: cam.position,
      zoom: cam.zoom,
      rule: held.rule,
      s: held.s,
      leadS: held.leadS,
      edge: held.edge,
    };
  });
}

// Every point the corridor sweep draws for a path's RANGE, in world metres,
// through a sink that records rather than paints.
function sweepPoints(rule: CameraRule & { kind: "path" }): Vec2[] {
  const pts: Vec2[] = [];
  const sink = {
    moveTo: (x: number, y: number) => void pts.push(new Vec2(x, y)),
    lineTo: (x: number, y: number) => void pts.push(new Vec2(x, y)),
    closePath: () => {},
    arc: () => {},
  };
  pathCorridorSweepInto(sink, rule.index, (s) => pathRangeAxes(pathParamsAt(rule, s)));
  return pts;
}

// The sum of a ride's frame-to-frame zoom travel over its last second: zero
// when the zoom has come to rest, and not when something is still pumping it.
function zoomTravel(out: readonly { zoom: number }[]): number {
  return out.slice(-60).reduce((a, o, i, arr) => (i ? a + Math.abs(o.zoom - arr[i - 1]!.zoom) : 0), 0);
}

export function runCameraCases(): CameraResult[] {
  return [
    run("segment-interior", () => {
      const r = project(SEGMENT, V(3, 4));
      return [
        { label: "s", got: r.s, want: 3 },
        { label: "dist", got: r.dist, want: 4 },
      ];
    }),

    run("segment-endpoint-clamps", () => {
      // Past either end the projection is the end itself, and the distance is
      // the true distance to the polyline rather than to its infinite line.
      const before = project(SEGMENT, V(-4, 3));
      const after = project(SEGMENT, V(14, 3));
      return [
        { label: "before.s", got: before.s, want: 0 },
        { label: "before.dist", got: before.dist, want: 5 },
        { label: "after.s", got: after.s, want: 10 },
        { label: "after.dist", got: after.dist, want: 5 },
      ];
    }),

    run("segment-on-the-line", () => {
      const r = project(SEGMENT, V(6.25, 0));
      return [
        { label: "s", got: r.s, want: 6.25 },
        { label: "dist", got: r.dist, want: 0 },
      ];
    }),

    run("corner-tie", () => {
      // Diagonally outside the corner, both segments project to the corner
      // itself and tie on distance. Whichever wins, `s` is the corner's.
      const r = project(ELL, V(13, -3));
      return [
        { label: "s", got: r.s, want: 10 },
        { label: "dist", got: r.dist, want: Math.hypot(3, 3) },
      ];
    }),

    run("corner-continuity", () => {
      // A point sweeping diagonally across the outside of the corner, from
      // alongside the first segment to alongside the second. `s` must climb
      // through 10 smoothly: no step larger than the sample spacing, and never
      // backwards. A branch flip is exactly what this would catch.
      const from = V(9, -1);
      const to = V(11, 1);
      const N = 32;
      const samples: number[] = [];
      for (let i = 0; i <= N; i++) {
        samples.push(project(ELL, from.add(to.sub(from).mul(i / N))).s);
      }
      let maxJump = 0;
      let backwards = 0;
      for (let i = 1; i < samples.length; i++) {
        const d = samples[i]! - samples[i - 1]!;
        if (d < -EPSILON) backwards++;
        maxJump = Math.max(maxJump, Math.abs(d));
      }
      return [
        { label: "backwards steps", got: backwards, want: 0 },
        { label: "max step", got: maxJump, want: 0, tol: 0.15 },
        { label: "first s", got: samples[0]!, want: 9 },
        { label: "mid s", got: samples[N / 2]!, want: 10 },
        { label: "last s", got: samples[samples.length - 1]!, want: 11 },
      ];
    }),

    run("point-at-arc-length", () => {
      const start = pointAtArcLength(ELL, 0);
      const mid = pointAtArcLength(ELL, 4);
      const corner = pointAtArcLength(ELL, 10);
      const past = pointAtArcLength(ELL, 999);
      const negative = pointAtArcLength(ELL, -3);
      return [
        { label: "total", got: ELL.total, want: 15 },
        { label: "start.x", got: start.x, want: 0 },
        { label: "start.y", got: start.y, want: 0 },
        { label: "mid.x", got: mid.x, want: 4 },
        { label: "mid.y", got: mid.y, want: 0 },
        { label: "corner.x", got: corner.x, want: 10 },
        { label: "corner.y", got: corner.y, want: 0 },
        { label: "past.x", got: past.x, want: 10 },
        { label: "past.y", got: past.y, want: 5 },
        { label: "negative.x", got: negative.x, want: 0 },
        { label: "negative.y", got: negative.y, want: 0 },
      ];
    }),

    run("switchback-global", () => {
      // A point 0.4 m above the LOWER branch and 1.6 m below the upper one. The
      // unrestricted query is right to pick the lower branch: it is the closest
      // point on the path, which is all it claims to answer.
      const r = project(SWITCHBACK, V(5, 1.6));
      return [
        { label: "total", got: SWITCHBACK.total, want: 22 },
        { label: "s", got: r.s, want: 17 },
        { label: "dist", got: r.dist, want: 0.4 },
      ];
    }),

    run("switchback-window", () => {
      // The same point, for a camera that was riding the UPPER branch at s = 5.
      // The window is what the player could plausibly have moved, so the answer
      // stays on the branch they fell off and reports the distance that
      // eventually releases the path - rather than teleporting 12 m of arc
      // length onto a branch they never reached.
      const checks: Check[] = [];
      let s = 5;
      for (const [y, want] of [
        [0.5, 0.5],
        [1.0, 1.0],
        [1.6, 1.6],
      ] as const) {
        const r = projectOntoPolylineWindow(SWITCHBACK, V(5, y), s - 0.6, s + 0.6);
        checks.push({ label: `y=${y} s`, got: r.s, want: 5 });
        checks.push({ label: `y=${y} dist`, got: r.dist, want });
        s = r.s;
      }
      // Sanity: the window is what makes the difference, not the geometry.
      checks.push({ label: "unwindowed s", got: project(SWITCHBACK, V(5, 1.6)).s, want: 17 });
      return checks;
    }),

    run("switchback-reacquire", () => {
      // Once the path has let go, re-acquisition is a fresh global query, and
      // it correctly lands on the lower branch the player is now on.
      const r = project(SWITCHBACK, V(3, 2.1));
      return [
        { label: "s", got: r.s, want: 19 },
        { label: "dist", got: r.dist, want: 0.1 },
      ];
    }),

    run("duplicate-verts", () => {
      // Consecutive duplicates contribute zero length: the same path, the same
      // arc lengths, no division by zero.
      const ix = buildPolylineIndex([V(0, 0), V(0, 0), V(10, 0), V(10, 0), V(10, 5)]);
      const r = project(ix, V(3, 4));
      const p = pointAtArcLength(ix, 0);
      return [
        { label: "total", got: ix.total, want: 15 },
        { label: "s", got: r.s, want: 3 },
        { label: "dist", got: r.dist, want: 4 },
        { label: "start.x", got: p.x, want: 0 },
        { label: "start.y", got: p.y, want: 0 },
      ];
    }),

    run("degenerate-all-coincident", () => {
      // Every vert in one place: no direction, nothing to ride. The level
      // format drops these at load; the geometry still answers rather than
      // returning NaN, so a caller that gets one is merely useless.
      const ix = buildPolylineIndex([V(2, 2), V(2, 2)]);
      const r = project(ix, V(2, 5));
      return [
        { label: "total", got: ix.total, want: 0 },
        { label: "s", got: r.s, want: 0 },
        { label: "dist", got: r.dist, want: 3 },
      ];
    }),

    run("world-frame-bake", () => {
      // The index is built in world space once: a path at (100, 50) rotated a
      // quarter turn projects a world point without any caller transforming
      // anything.
      const ix = buildPolylineIndex([V(0, 0), V(10, 0)], V(100, 50), Math.PI / 2);
      // Local +x becomes world +y, so the path runs from (100, 50) to (100, 60).
      const r = project(ix, V(103, 53));
      const end = pointAtArcLength(ix, 10);
      return [
        { label: "s", got: r.s, want: 3 },
        { label: "dist", got: r.dist, want: 3 },
        { label: "end.x", got: end.x, want: 100 },
        { label: "end.y", got: end.y, want: 60 },
      ];
    }),
    run("rule-path-leads-the-player", () => {
      // Snapped onto the path at x = 3, the camera sits at the lookahead point
      // and not on the player: the whole mechanism in one assertion.
      const rules = buildCameraRules([], [RIDE]);
      const [first] = ride(rules, [new Vec2(3, 0)]);
      return [
        { label: "rule is the path", got: first!.rule === rules[0] ? 1 : 0, want: 1 },
        { label: "s", got: first!.s, want: 3 },
        { label: "target.x", got: first!.pos.x, want: 5.5 },
        { label: "target.y", got: first!.pos.y, want: 0 },
      ];
    }),

    run("rule-path-leads-forward-when-backtracking", () => {
      // Walking backwards must not flip the lookahead: direction is the design,
      // so the screen keeps arguing for the authored way.
      const rules = buildCameraRules([], [RIDE]);
      const walk = [8, 7, 6, 5].map((x) => new Vec2(x, 0));
      const out = ride(rules, walk);
      const last = out[out.length - 1]!;
      return [
        { label: "s", got: last.s, want: 5 },
        // The camera is still eased, so what is asserted is the AIM: the target
        // is ahead of the player by the lookahead, and the camera is chasing it
        // from further along rather than from behind.
        {
          // Through the COMMITTED lead, which is what the camera actually aims
          // from: with the default buffer the band trails the projection by up
          // to its own width, and the target is still ahead of the player.
          label: "target is ahead of the player",
          got: cameraRuleTarget(last.rule, new Vec2(5, 0), BASE_ZOOM, last.leadS).pos.x > 5 ? 1 : 0,
          want: 1,
        },
        { label: "camera is ahead of the player", got: last.pos.x > 5 ? 1 : 0, want: 1 },
      ];
    }),

    run("rule-path-clamps-at-the-end", () => {
      // Near the goal the lookahead runs out of path and the camera comes to
      // rest on its end rather than staring past it.
      const rules = buildCameraRules([], [RIDE]);
      const [at] = ride(rules, [new Vec2(9.5, 0)]);
      return [
        { label: "target.x", got: at!.pos.x, want: 10 },
        { label: "target.y", got: at!.pos.y, want: 0 },
      ];
    }),

    run("rule-path-releases-to-the-region", () => {
      // Falling off the path by more than range + buffer hands the camera to
      // whatever governs where the player actually is.
      const rules = buildCameraRules([ROOM], [RIDE]);
      const held = ride(rules, [new Vec2(5, 0)])[0]!;
      const dropped = ride(rules, [new Vec2(5, 0), new Vec2(5, 1.1), new Vec2(5, 3)]);
      return [
        { label: "starts on the path", got: held.rule === rules[1] ? 1 : 0, want: 1 },
        // 1.1 m off a 1 m corridor is inside the 0.15 m jitter buffer, so the
        // path still holds: the release is buffered exactly as a region's is.
        { label: "holds inside the buffer", got: dropped[1]!.rule === rules[1] ? 1 : 0, want: 1 },
        { label: "releases to the room", got: dropped[2]!.rule === rules[0] ? 1 : 0, want: 1 },
      ];
    }),

    run("rule-path-reacquires", () => {
      // ...and coming back within range takes the path again, from a fresh
      // global projection rather than from the arc length it let go at.
      const rules = buildCameraRules([ROOM], [RIDE]);
      const out = ride(rules, [new Vec2(2, 0), new Vec2(5, 3), new Vec2(8, 0)]);
      return [
        { label: "released", got: out[1]!.rule === rules[0] ? 1 : 0, want: 1 },
        { label: "re-acquired", got: out[2]!.rule === rules[1] ? 1 : 0, want: 1 },
        { label: "s is the fresh projection", got: out[2]!.s, want: 8 },
      ];
    }),

    run("rule-handoff-does-not-snap", () => {
      // The frozen delta means the aim point is unchanged on the crossing
      // frame, so the camera carries its follow lag through the hand-off. What
      // that shows up as is the frame-to-frame camera step never spiking: a
      // snap would put metres into one frame of a walk that moves 5 cm.
      const rules = buildCameraRules([ROOM], [RIDE]);
      const walk: Vec2[] = [];
      for (let i = 0; i <= 120; i++) walk.push(new Vec2(5, i * 0.05));
      const out = ride(rules, walk);
      let maxStep = 0;
      for (let i = 1; i < out.length; i++) {
        maxStep = Math.max(maxStep, out[i]!.pos.distanceTo(out[i - 1]!.pos));
      }
      const changed = out.some((o, i) => i > 0 && o.rule !== out[i - 1]!.rule);
      return [
        { label: "the rule did change", got: changed ? 1 : 0, want: 1 },
        // The camera is easing toward a target several metres away, so the step
        // is bounded by the ease rather than by the walk; a snap is an order
        // above this.
        { label: "max camera step", got: maxStep, want: 0, tol: 0.35 },
      ];
    }),

    run("rule-path-beats-region-at-equal-priority", () => {
      // Listing paths after regions makes the tie-break favour the path: it is
      // the level's primary guide and a region is the local exception, which
      // says so by outranking it.
      const inside = new Vec2(5, 0.5);
      const overlapping: CameraRegionData = { ...ROOM, y: 0, lockY: 0 };
      const tie = buildCameraRules([overlapping], [RIDE]);
      const outranked = buildCameraRules([{ ...overlapping, priority: 1 }], [RIDE]);
      return [
        { label: "path wins the tie", got: activeCameraRule(tie, inside) === tie[1] ? 1 : 0, want: 1 },
        {
          label: "a higher-priority region wins",
          got: activeCameraRule(outranked, inside) === outranked[0] ? 1 : 0,
          want: 1,
        },
      ];
    }),

    run("rule-set-without-paths-is-regions-only", () => {
      // A level with no cameraPaths reduces to exactly what it was: the same
      // rules, in the same order, and the same answer.
      const rules = buildCameraRules([ROOM], []);
      return [
        { label: "rule count", got: rules.length, want: 1 },
        { label: "inside", got: activeCameraRule(rules, new Vec2(5, 4)) === rules[0] ? 1 : 0, want: 1 },
        { label: "outside", got: activeCameraRule(rules, new Vec2(50, 4)) === null ? 1 : 0, want: 1 },
      ];
    }),
    // --- the editor's round trip ---------------------------------------------
    //
    // The editor rewrites the whole file every 750 ms while a level is open, so
    // a field it drops is gone from disk before anyone notices it was read.
    // `modelFromDisk`/`modelToDisk` go through `EdItem`, which is a different
    // shape from `CameraPathData` entirely, so the format's own px -> m -> px
    // trip says nothing about this one.

    runFacts("editor-path-round-trip", () => {
      // Every field authored, in the scene pixels a file is written in.
      const authored: RawLevelData = {
        player: { x: 0, y: 0, radius: 20 },
        bodies: [],
        cameraPaths: [
          {
            x: 120,
            y: -80,
            rot: 0.35,
            verts: [
              { x: 0, y: 0 },
              { x: 400, y: 0 },
              { x: 400, y: 250 },
            ],
            rangeX: 350,
            rangeY: 200,
            falloffX: 180,
            falloffY: 90,
            lookaheadX: 220,
            lookaheadY: 120,
            lookaheadBufferX: 80,
            lookaheadBufferY: 45,
            viewportScale: 1.6,
            blend: 0.4,
            buffer: 60,
            priority: 2,
          },
        ],
      };
      const back = modelToDisk(modelFromDisk(authored));
      const out = back.cameraPaths?.[0];
      if (!out) return ["the path did not survive the round trip at all"];
      const bad: string[] = [];
      // The editor legitimately re-origins an item onto its verts' average, so
      // the placement is compared FLATTENED - each vert in world pixels - rather
      // than field by field, which would read that re-centring as a lost field.
      const flat = (p: CameraPathData): string =>
        p.verts
          .map((v) => {
            const c = Math.cos(p.rot);
            const s2 = Math.sin(p.rot);
            return `${(p.x + v.x * c - v.y * s2).toFixed(6)},${(p.y + v.x * s2 + v.y * c).toFixed(6)}`;
          })
          .join(" ");
      const want = authored.cameraPaths![0]!;
      if (flat(out) !== flat(want)) bad.push(`verts ${flat(out)} != ${flat(want)}`);
      if (Math.abs(out.rot - want.rot) > 1e-9) bad.push(`rot ${out.rot} != ${want.rot}`);
      for (const k of [
        "rangeX",
        "rangeY",
        "falloffX",
        "falloffY",
        "lookaheadX",
        "lookaheadY",
        "lookaheadBufferX",
        "lookaheadBufferY",
        "viewportScale",
        "blend",
        "buffer",
        "priority",
      ] as const) {
        if (Math.abs((out[k] ?? NaN) - (want[k] ?? NaN)) > 1e-6) {
          bad.push(`${k} ${String(out[k])} != ${String(want[k])}`);
        }
      }
      return bad;
    }),

    runFacts("editor-path-omits-defaults", () => {
      // A path with nothing authored writes nothing it did not author, which is
      // what makes a re-save byte-stable rather than a diff of defaults.
      const authored: RawLevelData = {
        player: { x: 0, y: 0, radius: 20 },
        bodies: [],
        cameraPaths: [
          {
            x: 0,
            y: 0,
            rot: 0,
            verts: [
              { x: -100, y: 0 },
              { x: 100, y: 0 },
            ],
          },
        ],
      };
      const out = modelToDisk(modelFromDisk(authored)).cameraPaths?.[0];
      if (!out) return ["the path did not survive the round trip at all"];
      const extra = Object.keys(out).filter((k) => !["x", "y", "rot", "verts"].includes(k));
      return extra.length ? [`wrote unauthored fields: ${extra.join(", ")}`] : [];
    }),

    runFacts("editor-without-paths-is-unchanged", () => {
      // The half no level on disk can fail loudly: a level authored before this
      // feature must come back with no `cameraPaths` key at all, and its regions
      // exactly as they were.
      const authored: RawLevelData = {
        player: { x: 0, y: 0, radius: 20 },
        bodies: [],
        cameraRegions: [
          { x: 40, y: 60, rot: 0, shape: { kind: "rect", w: 200, h: 100 }, buffer: 30 },
        ],
      };
      const back = modelToDisk(modelFromDisk(authored));
      const bad: string[] = [];
      if ("cameraPaths" in back) bad.push("minted a cameraPaths key on a level that has none");
      if (JSON.stringify(back.cameraRegions) !== JSON.stringify(authored.cameraRegions)) {
        bad.push(`regions changed: ${JSON.stringify(back.cameraRegions)}`);
      }
      return bad;
    }),

    runFacts("format-drops-degenerate-paths", () => {
      // A polyline with fewer than two DISTINCT verts has no direction, so there
      // is nothing to project onto. It is dropped at load rather than reaching a
      // controller that would have to guard against it every frame.
      const authored: RawLevelData = {
        player: { x: 0, y: 0, radius: 20 },
        bodies: [],
        cameraPaths: [
          { x: 0, y: 0, rot: 0, verts: [{ x: 0, y: 0 }] },
          { x: 0, y: 0, rot: 0, verts: [{ x: 5, y: 5 }, { x: 5, y: 5 }] },
          { x: 0, y: 0, rot: 0, verts: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
        ],
      };
      const kept = scaleLevelData(authored, 1).cameraPaths ?? [];
      return kept.length === 1 ? [] : [`kept ${kept.length} of 3 paths, expected 1`];
    }),
    // --- the screen-edge guarantee ------------------------------------------
    //
    // Whatever rule is in force, the avatar may never enter the outer
    // CAMERA_EDGE_MARGIN of the frame. It is a clamp on where the camera IS
    // rather than on what it aims at, because a target the avatar can outrun is
    // not a guarantee.

    runFacts("edge-holds-under-a-huge-lookahead", () => {
      // A lookahead far wider than the frame aims the camera right off the
      // avatar. The clamp is what stops that being the avatar off the screen.
      const path: CameraPathData = {
        ...RIDE,
        verts: [
          { x: 0, y: 0 },
          { x: 200, y: 0 },
        ],
        lookaheadX: 60,
        lookaheadY: 60,
      };
      const rules = buildCameraRules([], [path]);
      const walk: Vec2[] = [];
      for (let i = 0; i < 200; i++) walk.push(new Vec2(20 + i * 0.05, 0));
      const out = ride(rules, walk);
      const r = edgeReach(stubCamera(), BASE_ZOOM);
      const bad = out.filter(
        (o, i) => Math.abs(walk[i]!.x - o.pos.x) > r.x + 1e-9 || Math.abs(walk[i]!.y - o.pos.y) > r.y + 1e-9,
      );
      const held = out.filter((o) => o.edge !== null).length;
      return [
        ...(bad.length ? [`${bad.length} of ${out.length} frames put the avatar in the edge band`] : []),
        // ...and the constraint really was doing the work, or the case proves
        // nothing about the clamp.
        ...(held === 0 ? ["the clamp never bound, so this asserts nothing"] : []),
      ];
    }),

    runFacts("edge-holds-under-a-locked-region", () => {
      // A region that pins both axes will happily frame a room the avatar has
      // left. It may not frame one the avatar is off the edge of.
      const room: CameraRegionData = {
        x: 0,
        y: 0,
        rot: 0,
        shape: { kind: "rect", w: 400, h: 400 },
        lockX: 0,
        lockY: 0,
      };
      const rules = buildCameraRules([room], []);
      const walk: Vec2[] = [];
      for (let i = 0; i < 300; i++) walk.push(new Vec2(i * 0.2, i * 0.1));
      const out = ride(rules, walk);
      const r = edgeReach(stubCamera(), BASE_ZOOM);
      const bad = out.filter(
        (o, i) => Math.abs(walk[i]!.x - o.pos.x) > r.x + 1e-9 || Math.abs(walk[i]!.y - o.pos.y) > r.y + 1e-9,
      );
      return bad.length ? [`${bad.length} of ${out.length} frames put the avatar in the edge band`] : [];
    }),

    runFacts("edge-holds-through-a-teleport", () => {
      // The ease cannot keep up with a launch, and the guarantee does not
      // depend on it: one frame that moves the avatar half a level still ends
      // with it on screen.
      const rules = buildCameraRules([], []);
      const out = ride(rules, [new Vec2(0, 0), new Vec2(400, -300), new Vec2(-90, 250)]);
      const r = edgeReach(stubCamera(), BASE_ZOOM);
      const walk = [new Vec2(0, 0), new Vec2(400, -300), new Vec2(-90, 250)];
      const bad = out.filter(
        (o, i) => Math.abs(walk[i]!.x - o.pos.x) > r.x + 1e-9 || Math.abs(walk[i]!.y - o.pos.y) > r.y + 1e-9,
      );
      return bad.length ? [`${bad.length} frames put the avatar in the edge band`] : [];
    }),

    run("edge-never-binds-at-ordinary-speed", () => {
      // The default camera centres the avatar, so the only thing that can put it
      // near the edge under the plain follow is OUTRUNNING THE EASE - and the
      // ease settles at a lag of `speed * CAMERA_FOLLOW_TAU`, which at the
      // reach here needs a sustained 27 m/s before it binds. A hard swing is
      // around 10. So the clamp is inert in ordinary play, which is what makes
      // it safe to apply globally rather than as a rule a level opts into.
      const rules = buildCameraRules([], []);
      const walk: Vec2[] = [];
      // A 3 m wander at a two-second period: about 9.4 m/s at its fastest.
      for (let i = 0; i < 240; i++) {
        walk.push(new Vec2(Math.sin((i / 120) * Math.PI * 2) * 3, Math.cos((i / 120) * Math.PI * 2) * 2));
      }
      const out = ride(rules, walk);
      const worst = Math.max(...out.map((o, i) => Math.abs(walk[i]!.x - o.pos.x)));
      const reach = edgeReach(stubCamera(), BASE_ZOOM).x;
      return [
        { label: "frames the clamp bound on", got: out.filter((o) => o.edge !== null).length, want: 0 },
        // ...with room to spare, so the case is not sitting on the threshold.
        { label: "worst lag as a fraction of the reach", got: worst / reach, want: 0, tol: 0.5 },
      ];
    }),

    runFacts("edge-clamp-is-switchable-for-authoring", () => {
      // The editor's ▶ Test can turn the guarantee off, so an author can see the
      // framing a rule is actually asking for rather than the one the backstop
      // allowed. It is an instrument and not a level property: the game never
      // touches the switch, and nothing writes it to a file.
      //
      // Asserted as the two halves it has to be - the same walk held on screen
      // with it on, and NOT held with it off, or the toggle is connected to
      // nothing.
      const room: CameraRegionData = {
        x: 0,
        y: 0,
        rot: 0,
        shape: { kind: "rect", w: 400, h: 400 },
        lockX: 0,
        lockY: 0,
      };
      const rules = buildCameraRules([room], []);
      const walk: Vec2[] = [];
      for (let i = 0; i < 200; i++) walk.push(new Vec2(i * 0.2, i * 0.1));
      const r = edgeReach(stubCamera(), BASE_ZOOM);
      const outside = (o: { pos: Vec2 }, i: number): boolean =>
        Math.abs(walk[i]!.x - o.pos.x) > r.x + 1e-9 || Math.abs(walk[i]!.y - o.pos.y) > r.y + 1e-9;
      const on = ride(rules, walk).filter(outside).length;
      const off = ride(rules, walk, false).filter(outside).length;
      const bad: string[] = [];
      if (on !== 0) bad.push(`${on} frames left the frame with the clamp on`);
      if (off === 0) bad.push("the walk never left the frame with the clamp off, so this asserts nothing");
      return bad;
    }),

    run("edge-reach-is-a-fraction-of-the-frame", () => {
      // It is measured in SCREEN terms, so a region that zooms out has a wider
      // keep-out in metres and the same one in pixels. A margin in metres would
      // shrink to a sliver of the frame exactly where the frame got roomier.
      const cam = stubCamera();
      const near = edgeReach(cam, BASE_ZOOM);
      const far = edgeReach(cam, BASE_ZOOM / 3);
      const halfW = cam.viewportWidth / 2 / (BASE_ZOOM * 100);
      return [
        { label: "reach x", got: near.x, want: halfW * (1 - 2 * CAMERA_EDGE_MARGIN) },
        { label: "zooming out widens it in metres", got: far.x / near.x, want: 3 },
        // 16:9, so the vertical keep-out is the same fraction of a shorter axis.
        { label: "y is the frame's own ratio", got: near.y / near.x, want: 1080 / 1920 },
      ];
    }),

    // --- the falloff band ---------------------------------------------------
    //
    // Crossing `range` used to swap the rule outright: aiming down the route one
    // frame and at the avatar the next. Through the band the path's target is
    // interpolated toward the plain follow instead, so by the time the grip runs
    // out the two targets are identical and the release delta is exactly zero.

    run("falloff-weight-shape", () => {
      // The weight is 0 anywhere inside the range, 1 at the band's outer edge
      // and beyond, and C1 at both edges - a kink in the weight is a step in
      // the camera's velocity, which reads as the camera catching on an
      // invisible line. A zero falloff means no band: the path keeps its full
      // grip out to the release, which is the pre-band behaviour.
      const path: CameraPathData = { ...RIDE, falloffX: 2, falloffY: 2 };
      const hard: CameraPathData = { ...RIDE };
      const h = 1e-3;
      const w = (d: number): number => pathFalloffWeight(pathParamsOf(path), V(0, d));
      return [
        { label: "on the route", got: w(0), want: 0 },
        { label: "exactly at the range", got: w(1), want: 0 },
        { label: "mid-band", got: w(2), want: 0.5 },
        { label: "at the band's outer edge", got: w(3), want: 1 },
        { label: "far past the band", got: w(10), want: 1 },
        { label: "flat at the inner edge", got: (w(1 + h) - w(1)) / h, want: 0, tol: 0.01 },
        { label: "flat at the outer edge", got: (w(3) - w(3 - h)) / h, want: 0, tol: 0.01 },
        { label: "zero falloff keeps full grip", got: pathFalloffWeight(pathParamsOf(hard), V(0, 5)), want: 0 },
      ];
    }),

    run("falloff-blends-toward-the-plain-follow", () => {
      // The target through the band, with a viewportScale so the zoom half of
      // the claim is not vacuous: pure path at the boundary, EXACTLY the null
      // rule's target - the avatar at the base zoom - at the outer edge, and
      // the straight interpolation between the two mid-band (geometric for the
      // zoom, as every zoom blend here is).
      const path: CameraPathData = { ...RIDE, falloffX: 2, falloffY: 2, viewportScale: 2 };
      const rule = buildCameraRules([], [path])[0]!;
      const at = (dist: number): { pos: Vec2; zoom: number } =>
        cameraRuleTarget(rule, new Vec2(5, dist), BASE_ZOOM, 5, pathFalloffWeight(pathParamsOf(path), V(0, dist)));
      const boundary = at(1);
      const mid = at(2);
      const edge = at(3);
      return [
        // At the boundary: the full lead along the route, at the path's zoom.
        { label: "boundary target x", got: boundary.pos.x, want: 7.5 },
        { label: "boundary target y", got: boundary.pos.y, want: 0 },
        { label: "boundary zoom", got: boundary.zoom, want: BASE_ZOOM / 2 },
        // Mid-band: halfway between the path's target and the avatar.
        { label: "mid-band target x", got: mid.pos.x, want: 6.25 },
        { label: "mid-band target y", got: mid.pos.y, want: 1 },
        { label: "mid-band zoom is the geometric mean", got: mid.zoom, want: Math.sqrt((BASE_ZOOM / 2) * BASE_ZOOM), tol: 1e-9 },
        // Outer edge: the plain follow, identically - this equality is what
        // makes the release delta zero.
        { label: "edge target x", got: edge.pos.x, want: 5 },
        { label: "edge target y", got: edge.pos.y, want: 3 },
        { label: "edge zoom is the base zoom", got: edge.zoom, want: BASE_ZOOM },
      ];
    }),

    runFacts("falloff-release-is-seamless", () => {
      // The claim the whole design is for: by the time the path lets go its
      // target has already become the plain follow, so the release moves the
      // camera by nothing. Walk out through the band, stand still past the
      // release, and measure what the camera does after the rule changes -
      // under the old positional drift it glided ~2.7 m of leftover lookahead
      // here; under the weight it has nothing left to do.
      const path: CameraPathData = { ...RIDE, falloffX: 2, falloffY: 2, buffer: 0.15 };
      const rules = buildCameraRules([], [path]);
      // Slowly (0.6 m/s), so the follow ease's own lag stays small and what is
      // measured is the release rather than the walk.
      const walk: Vec2[] = [];
      for (let d = 0; d <= 3.2; d += 0.01) walk.push(new Vec2(5, d));
      for (let i = 0; i < 120; i++) walk.push(new Vec2(5, 3.2));
      const out = ride(rules, walk);
      const release = out.findIndex((o, i) => i > 0 && out[i - 1]!.rule !== null && o.rule === null);
      if (release < 0) return ["the path never released"];
      const travel = out
        .slice(release)
        .reduce((a, o, i, arr) => (i ? a + o.pos.distanceTo(arr[i - 1]!.pos) : 0), 0);
      return travel > 0.3
        ? [`the camera travelled ${travel.toFixed(2)} m after the release`]
        : [];
    }),

    runFacts("falloff-holds-then-releases", () => {
      // The band extends the path's grip: it holds through `range + falloff`
      // and its jitter buffer, and lets go past that. Acquisition is unchanged -
      // the path is taken on the core range alone, so drifting IN through the
      // band does not grab the camera early.
      const path: CameraPathData = { ...RIDE, falloffX: 2, falloffY: 2, buffer: 0.15 };
      const rules = buildCameraRules([ROOM], [path]);
      const bad: string[] = [];
      const rel = pathRelease(pathParamsOf(path), V(0, 1));
      if (Math.abs(rel - 3.15) > 1e-9) bad.push(`release at ${rel}, want 3.15`);
      // Ride out from the route and check where it lets go.
      const held = ride(rules, [new Vec2(5, 0), new Vec2(5, 2.5), new Vec2(5, 3.1)]);
      if (held[1]!.rule !== rules[1]) bad.push("let go inside the falloff band");
      if (held[2]!.rule !== rules[1]) bad.push("let go inside the jitter buffer");
      const gone = ride(rules, [new Vec2(5, 0), new Vec2(5, 3.5)]);
      if (gone[1]!.rule === rules[1]) bad.push("still holding past the release distance");
      // ...and coming from outside, the band is not a wider acquisition.
      const inward = ride(rules, [new Vec2(5, 6), new Vec2(5, 2.5)]);
      if (inward[1]!.rule === rules[1]) bad.push("acquired the path from inside the falloff band");
      return bad;
    }),

    run("range-and-falloff-are-per-axis", () => {
      // The pairs are the semi-axes of ellipses around the route, resolved
      // along the direction the player actually left in - so the corridor is
      // screen-shaped. The frame is 16:9: a circular corridor wide enough to
      // mean anything horizontally is off the bottom of the screen vertically,
      // which is exactly how the ball used to leave the frame with the edge
      // clamp off.
      const path: CameraPathData = { ...RIDE, rangeX: 4, rangeY: 1, falloffX: 2, falloffY: 0.5 };
      return [
        { label: "range along the route", got: pathRange(pathParamsOf(path), V(1, 0)), want: 4 },
        { label: "range straight off it", got: pathRange(pathParamsOf(path), V(0, 1)), want: 1 },
        { label: "band edge along", got: pathBand(pathParamsOf(path), V(1, 0)), want: 6 },
        { label: "band edge straight off", got: pathBand(pathParamsOf(path), V(0, 1)), want: 1.5 },
        // The same distance off the route is mid-band vertically and not even
        // out of the corridor horizontally.
        { label: "weight 1.25 m below", got: pathFalloffWeight(pathParamsOf(path), V(0, 1.25)), want: 0.5 },
        { label: "weight 1.25 m along", got: pathFalloffWeight(pathParamsOf(path), V(1.25, 0)), want: 0 },
      ];
    }),

    runFacts("acquisition-is-screen-shaped", () => {
      // The consequence of the pair, on the rule set: a player 2 m below the
      // route is outside a 1 m vertical range and does not take the path, while
      // one 3 m past its END - a horizontal displacement - is inside the 4 m
      // horizontal range and does. A circular range passing either both or
      // neither is what this is red against.
      const path: CameraPathData = { ...RIDE, rangeX: 4, rangeY: 1 };
      const rules = buildCameraRules([], [path]);
      const bad: string[] = [];
      if (activeCameraRule(rules, V(5, 2)) !== null) bad.push("acquired 2 m below a 1 m vertical range");
      if (activeCameraRule(rules, V(13, 0)) !== rules[0]) bad.push("did not acquire 3 m past the end, inside the horizontal range");
      return bad;
    }),

    runFacts("switchback-branch-reacquire", () => {
      // A held path must re-acquire its OWN other branch when the player has
      // genuinely left the ridden one and landed inside the other's corridor.
      // The windowed projection deliberately cannot walk there (that is the
      // switchback protection), so without the branch challenge the ridden
      // branch's falloff zone outprioritises the branch under the player's
      // feet: in session-285f the ball fell through the lower branch's
      // corridor at 0.05 m while the grip clung to the upper one at 5.4 m,
      // released 6 cm outside the lower range, and the path never re-acquired.
      //
      // The jump must also BLEND - it moves the lookahead target by the arc
      // gap between the branches, and a reseed that skips the frozen-delta
      // hand-off snaps the camera by exactly that gap.
      const path: CameraPathData = {
        x: 0,
        y: 0,
        rot: 0,
        // The SWITCHBACK: upper branch y = 0 (s 0..10), lower y = 2 (s 12..22,
        // running back toward x = 0).
        verts: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 2 },
          { x: 0, y: 2 },
        ],
        rangeX: 0.5,
        rangeY: 0.5,
        // Wide enough that the 2 m drop between branches cannot RELEASE the
        // path: this case is about the challenge, not the release.
        falloffX: 5,
        falloffY: 5,
        lookaheadX: 1,
        lookaheadY: 1,
        lookaheadBufferX: 0,
        lookaheadBufferY: 0,
      };
      const rules = buildCameraRules([], [path]);
      const walk: Vec2[] = [];
      for (let x = 2; x <= 5; x += 0.05) walk.push(V(x, 0)); // ride the upper branch
      for (let y = 0; y <= 2; y += 0.05) walk.push(V(5, y)); // fall off it
      for (let i = 0; i < 120; i++) walk.push(V(5, 2)); // rest on the lower one
      const out = ride(rules, walk);
      const bad: string[] = [];
      const last = out[out.length - 1]!;
      if (last.rule === null) bad.push("the path released instead of re-acquiring");
      // The lower branch under (5, 2) is s = 12 + (10 - 5) = 17.
      if (Math.abs(last.s - 17) > 0.1)
        bad.push(`held s ended at ${last.s.toFixed(2)}, want 17 (the lower branch)`);
      let worst = 0;
      for (let i = 1; i < out.length; i++)
        worst = Math.max(worst, out[i]!.pos.distanceTo(out[i - 1]!.pos));
      if (worst > 0.15)
        bad.push(`the camera moved ${worst.toFixed(3)} m in one frame - the branch jump snapped`);
      return bad;
    }),

    run("path-scalar-range-folds-to-both-axes", () => {
      // The retired scalar `range`/`falloff` were one circular radius each.
      // `scaleLevelData` - the one gate every level passes through - folds each
      // into both axes, so a level that authored a circle keeps exactly that
      // circle and nothing downstream reads the scalar fields at all.
      const raw: RawLevelData = {
        player: { x: 0, y: 0, radius: 20 },
        bodies: [],
        cameraPaths: [
          {
            x: 0,
            y: 0,
            rot: 0,
            verts: [
              { x: 0, y: 0 },
              { x: 100, y: 0 },
            ],
            range: 150,
            falloff: 50,
          },
        ],
      };
      const p = scaleLevelData(raw, 0.01).cameraPaths![0]!;
      return [
        { label: "rangeX", got: p.rangeX ?? NaN, want: 1.5 },
        { label: "rangeY", got: p.rangeY ?? NaN, want: 1.5 },
        { label: "falloffX", got: p.falloffX ?? NaN, want: 0.5 },
        { label: "falloffY", got: p.falloffY ?? NaN, want: 0.5 },
        // The scalar forms are consumed by the fold, not carried alongside it.
        { label: "scalar range is gone", got: p.range === undefined ? 1 : 0, want: 1 },
        { label: "scalar falloff is gone", got: p.falloff === undefined ? 1 : 0, want: 1 },
      ];
    }),

    // --- the lookahead buffer -----------------------------------------------
    //
    // A swing is an oscillation ALONG the route, so a lead taken from the
    // avatar's projection exactly sloshes the camera back and forth with it.
    // The committed point is held in a deadband instead.

    run("lead-buffer-absorbs-a-swing", () => {
      // A swing whose travel along the path is narrower than the band moves the
      // committed point by NOTHING after the frame it acquires on - so the
      // camera has nothing to slosh toward. Not merely damped: absorbed.
      const path: CameraPathData = { ...RIDE, lookaheadBufferX: 1, lookaheadBufferY: 1 };
      const rules = buildCameraRules([], [path]);
      const walk: Vec2[] = [];
      for (let i = 0; i < 240; i++) walk.push(new Vec2(5 + 0.4 * Math.sin(i / 4), 0));
      const out = ride(rules, walk);
      const leads = out.map((o) => o.leadS);
      const projections = out.map((o) => o.s);
      return [
        { label: "the projection really does swing", got: Math.max(...projections) - Math.min(...projections), want: 0.8, tol: 0.02 },
        { label: "committed lead range", got: Math.max(...leads) - Math.min(...leads), want: 0 },
        // ...and the camera comes to a stop, rather than tracking the swing.
        {
          label: "camera travel over the last second",
          got: out
            .slice(-60)
            .reduce((a, o, i, arr) => (i ? a + o.pos.distanceTo(arr[i - 1]!.pos) : 0), 0),
          want: 0,
          tol: 1e-6,
        },
      ];
    }),

    run("lead-buffer-off-tracks-the-swing", () => {
      // The control: the same swing with no buffer moves the camera every
      // frame, which is the behaviour the band exists to remove.
      const path: CameraPathData = { ...RIDE, lookaheadBufferX: 0, lookaheadBufferY: 0 };
      const rules = buildCameraRules([], [path]);
      const walk: Vec2[] = [];
      for (let i = 0; i < 240; i++) walk.push(new Vec2(5 + 0.4 * Math.sin(i / 4), 0));
      const out = ride(rules, walk);
      const leads = out.map((o) => o.leadS);
      const travel = out
        .slice(-60)
        .reduce((a, o, i, arr) => (i ? a + o.pos.distanceTo(arr[i - 1]!.pos) : 0), 0);
      return [
        { label: "the lead tracks the projection exactly", got: Math.max(...leads) - Math.min(...leads), want: 0.8, tol: 0.02 },
        { label: "the camera keeps moving", got: travel > 1 ? 1 : 0, want: 1 },
      ];
    }),

    run("lead-buffer-is-dragged-past-its-width", () => {
      // A swing WIDER than the band still moves the camera, and by exactly the
      // excursion less the band on each side: the committed point is dragged by
      // the band's edge and by nothing else.
      const path: CameraPathData = { ...RIDE, lookaheadBufferX: 1, lookaheadBufferY: 1 };
      const rules = buildCameraRules([], [path]);
      const walk: Vec2[] = [];
      for (let i = 0; i < 300; i++) walk.push(new Vec2(5 + 2 * Math.sin(i / 8), 0));
      // The last full cycle, so the first half-swing's transient is behind us.
      const leads = ride(rules, walk).slice(-100).map((o) => o.leadS);
      return [
        { label: "committed lead range", got: Math.max(...leads) - Math.min(...leads), want: 2, tol: 0.05 },
      ];
    }),

    run("lead-buffer-is-per-axis", () => {
      // The band is resolved through the same ellipse the lead is, so one
      // authored for a corridor is not most of the vertical screen in a shaft.
      // A swing of the same size along a vertical route is therefore absorbed
      // by `lookaheadBufferY` and not by `lookaheadBufferX`.
      const band = { lookaheadBufferX: 2, lookaheadBufferY: 0.2 };
      const across: CameraPathData = {
        x: 0,
        y: 0,
        rot: 0,
        verts: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
        ],
        ...band,
      };
      const down: CameraPathData = { ...across, verts: [{ x: 0, y: 0 }, { x: 0, y: 20 }] };
      // The same 1 m of back-and-forth along each route: inside the 2 m band on
      // the horizontal one, well outside the 0.2 m band on the vertical one.
      const range = (p: CameraPathData, axis: "x" | "y"): number => {
        const rules = buildCameraRules([], [p]);
        const walk: Vec2[] = [];
        for (let i = 0; i < 200; i++) {
          const d = 5 + 0.5 * Math.sin(i / 5);
          walk.push(axis === "x" ? new Vec2(d, 0) : new Vec2(0, d));
        }
        const leads = ride(rules, walk).slice(-60).map((o) => o.leadS);
        return Math.max(...leads) - Math.min(...leads);
      };
      return [
        { label: "horizontal swing is absorbed", got: range(across, "x"), want: 0 },
        // 1 m of travel against a 0.2 m band leaves 1 - 2*0.2 of excursion.
        { label: "vertical swing is not", got: range(down, "y"), want: 0.6, tol: 0.05 },
      ];
    }),

    run("lead-buffer-centres-on-acquisition", () => {
      // Taking a path is history-free, so the band starts centred on the avatar
      // rather than holding an offset earned somewhere else on the route -
      // including after a release and a re-acquisition.
      const rules = buildCameraRules([ROOM], [{ ...RIDE, lookaheadBufferX: 1, lookaheadBufferY: 1 }]);
      const first = ride(rules, [new Vec2(2, 0)])[0]!;
      const out = ride(rules, [new Vec2(2, 0), new Vec2(5, 3), new Vec2(8, 0)]);
      return [
        { label: "on entry", got: first.leadS - first.s, want: 0 },
        { label: "released", got: out[1]!.rule === rules[0] ? 1 : 0, want: 1 },
        { label: "on re-acquisition", got: out[2]!.leadS - out[2]!.s, want: 0 },
      ];
    }),

    run("rule-path-lookahead-is-per-axis", () => {
      // A 16:9 frame has far less screen above and below the player than either
      // side of them, so the lead is an ELLIPSE: a horizontal route leads by
      // `lookaheadX`, a vertical one by `lookaheadY`, and a diagonal by what
      // fits between. Asserted through the target the camera actually takes,
      // which is what makes it a statement about the framing.
      const lead = { lookaheadX: 4, lookaheadY: 1 };
      const across: CameraPathData = {
        x: 0,
        y: 0,
        rot: 0,
        verts: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
        ],
        ...lead,
      };
      const down: CameraPathData = {
        x: 0,
        y: 0,
        rot: 0,
        verts: [
          { x: 0, y: 0 },
          { x: 0, y: 20 },
        ],
        ...lead,
      };
      const diagonal: CameraPathData = {
        x: 0,
        y: 0,
        rot: 0,
        verts: [
          { x: 0, y: 0 },
          { x: 20, y: 20 },
        ],
        ...lead,
      };
      const at = (p: CameraPathData, follow: Vec2): Vec2 => {
        const rules = buildCameraRules([], [p]);
        return ride(rules, [follow])[0]!.pos;
      };
      const diag = at(diagonal, new Vec2(5, 5));
      // 1 / hypot(cos45/4, sin45/1) = 0.9701, so the target is that far along a
      // 45-degree route: 0.686 on each axis.
      const want = 1 / Math.hypot(Math.SQRT1_2 / 4, Math.SQRT1_2 / 1);
      return [
        { label: "horizontal lead", got: at(across, new Vec2(5, 0)).x - 5, want: 4 },
        { label: "vertical lead", got: at(down, new Vec2(0, 5)).y - 5, want: 1 },
        { label: "diagonal lead x", got: diag.x - 5, want: want * Math.SQRT1_2 },
        { label: "diagonal lead y", got: diag.y - 5, want: want * Math.SQRT1_2 },
        // ...and the ARC LENGTH it leads by sits between the two axes' own,
        // which is what "the diagonal takes what fits between them" means. Per
        // axis the displacement is inside both: the ellipse binds on whichever
        // axis is tighter, and here that is y.
        { label: "arc lead is over the vertical", got: want > 1 ? 1 : 0, want: 1 },
        { label: "arc lead is under the horizontal", got: want < 4 ? 1 : 0, want: 1 },
        { label: "y displacement is within the vertical lead", got: diag.y - 5 <= 1 ? 1 : 0, want: 1 },
        { label: "x displacement is well under the horizontal", got: diag.x - 5 < 4 ? 1 : 0, want: 1 },
      ];
    }),

    // --- curved paths --------------------------------------------------------
    //
    // A path's nodes carry cubic Bézier tangent handles, and the whole of what
    // they cost is the flattening: everything downstream rides a polyline, and
    // a flattened cubic IS one.

    run("flatten-corners-are-the-polyline", () => {
      // Zero handles everywhere = a corner at every node, so the flattening is
      // exactly the nodes. This is what makes every path authored as a polyline
      // bit-identical to what it was before handles existed.
      const nodes: PathNode[] = [
        { p: V(0, 0), in: Vec2.ZERO, out: Vec2.ZERO },
        { p: V(10, 0), in: Vec2.ZERO, out: Vec2.ZERO },
        { p: V(10, 5), in: Vec2.ZERO, out: Vec2.ZERO },
      ];
      const flat = flattenPath(nodes);
      return [
        { label: "point count", got: flat.length, want: 3 },
        { label: "p1.x", got: flat[1]!.x, want: 10 },
        { label: "p1.y", got: flat[1]!.y, want: 0 },
        { label: "p2.y", got: flat[2]!.y, want: 5 },
      ];
    }),

    run("flatten-passes-through-its-nodes", () => {
      // A cubic interpolates its endpoints exactly, whatever the handles, so a
      // curved path still goes through every point the author placed.
      const nodes: PathNode[] = [
        { p: V(0, 0), in: Vec2.ZERO, out: V(3, -3) },
        { p: V(10, 0), in: V(-3, -3), out: V(3, 3) },
        { p: V(14, 8), in: V(0, -4), out: Vec2.ZERO },
      ];
      const flat = flattenPath(nodes);
      const on = (p: Vec2): number =>
        Math.min(...flat.map((q) => q.distanceTo(p)));
      return [
        { label: "node 0 is on the curve", got: on(V(0, 0)), want: 0 },
        { label: "node 1 is on the curve", got: on(V(10, 0)), want: 0 },
        { label: "node 2 is on the curve", got: on(V(14, 8)), want: 0 },
        // ...and it actually bows: the midpoint of a curved edge is nowhere
        // near the chord, or the handles are doing nothing.
        {
          label: "the edge bows off its chord",
          got: cubicAt(V(0, 0), V(3, -3), V(7, -3), V(10, 0), 0.5).y,
          want: -2.25,
        },
      ];
    }),

    run("flatten-samples-finely-enough", () => {
      // The flattening is what `range` is measured against, so the chordal error
      // has to be far below the metres a corridor is authored in. Measured as
      // the worst gap between the true curve and the flattened one, over a
      // deliberately hard edge (handles as long as the edge itself).
      const a: PathNode = { p: V(0, 0), in: Vec2.ZERO, out: V(0, -6) };
      const b: PathNode = { p: V(6, 0), in: V(0, -6), out: Vec2.ZERO };
      const ix = buildPolylineIndex(flattenPath([a, b]));
      let worst = 0;
      for (let i = 0; i <= 200; i++) {
        const t = i / 200;
        const p = cubicAt(a.p, a.p.add(a.out), b.p.add(b.in), b.p, t);
        worst = Math.max(worst, projectOntoPolyline(ix, p).dist);
      }
      return [{ label: "worst chordal error (m)", got: worst, want: 0, tol: 0.01 }];
    }),

    run("flatten-reads-absent-handles-as-corners", () => {
      // The on-disk form's optional fields and the geometry's plain vectors
      // agree about what "no handle" means, through one conversion.
      const nodes = pathNodesOf([
        { x: 0, y: 0 },
        { x: 4, y: 0, inX: -1 },
        { x: 8, y: 0 },
      ]);
      return [
        { label: "node 0 in.x", got: nodes[0]!.in.x, want: 0 },
        { label: "node 0 out.y", got: nodes[0]!.out.y, want: 0 },
        { label: "node 1 in.x", got: nodes[1]!.in.x, want: -1 },
        { label: "node 1 in.y", got: nodes[1]!.in.y, want: 0 },
      ];
    }),

    runFacts("editor-curve-round-trip", () => {
      // A handled node survives the editor's own trip, and a corner still
      // writes nothing - which is what keeps a polyline path byte-stable while
      // a curved one keeps its shape.
      const authored: RawLevelData = {
        player: { x: 0, y: 0, radius: 20 },
        bodies: [],
        cameraPaths: [
          {
            x: 0,
            y: 0,
            rot: 0,
            verts: [
              { x: -300, y: 0, outX: 100, outY: -80 },
              { x: 0, y: 0, inX: -100, inY: -80, outX: 100, outY: 80 },
              { x: 300, y: 0 },
            ],
          },
        ],
      };
      const out = modelToDisk(modelFromDisk(authored)).cameraPaths?.[0];
      if (!out) return ["the path did not survive the round trip at all"];
      const bad: string[] = [];
      const want = authored.cameraPaths![0]!;
      for (let i = 0; i < want.verts.length; i++) {
        for (const k of ["inX", "inY", "outX", "outY"] as const) {
          const a = out.verts[i]?.[k];
          const b = want.verts[i]![k];
          if (a === undefined && b === undefined) continue;
          if (Math.abs((a ?? NaN) - (b ?? NaN)) > 1e-6) {
            bad.push(`vert ${i} ${k}: ${String(a)} != ${String(b)}`);
          }
        }
      }
      // The corner node must still write four keys and no more.
      const last = Object.keys(out.verts[2] ?? {});
      if (last.length !== 2 || !last.includes("x") || !last.includes("y")) {
        bad.push(`a corner wrote ${last.join(",")}`);
      }
      return bad;
    }),

    // --- keys ---------------------------------------------------------------
    //
    // A node may key the path's target-shaping fields (see `CameraPathVert`),
    // so the framing changes along the route. The claims: a key sits at its
    // node's arc length however curved the edge into it; the interpolation
    // holds at the ends, smoothsteps between and is transparent to an unkeyed
    // node; and the keys are read at the committed lead origin, so a swing
    // across a change moves nothing.

    run("keys-sit-at-node-arc-lengths", () => {
      // A bowed edge is longer than its chord, so a key placed by node INDEX
      // and one placed by arc length are different places; the index records
      // the arc length and the point there is the node.
      const nodes: PathNode[] = [
        { p: V(0, 0), in: V(0, 0), out: V(2, -3) },
        { p: V(6, 0), in: V(-2, -3), out: V(0, 0) },
        { p: V(10, 0), in: V(0, 0), out: V(0, 0) },
      ];
      const flat = flattenPathNodes(nodes);
      const ix = buildPolylineIndex(flat.points, V(0, 0), 0, flat.nodeAt);
      const at1 = pointAtArcLength(ix, ix.nodeS[1]!);
      const at2 = pointAtArcLength(ix, ix.nodeS[2]!);
      return [
        { label: "node count", got: ix.nodeS.length, want: 3 },
        { label: "first node at s = 0", got: ix.nodeS[0]!, want: 0 },
        { label: "the curved edge is longer than its chord", got: ix.nodeS[1]! > 6.5 ? 1 : 0, want: 1 },
        { label: "node 1 x", got: at1.x, want: 6, tol: 1e-6 },
        { label: "node 1 y", got: at1.y, want: 0, tol: 1e-6 },
        { label: "node 2 x", got: at2.x, want: 10, tol: 1e-6 },
        { label: "last node at the total", got: ix.nodeS[2]!, want: ix.total, tol: 1e-9 },
      ];
    }),

    run("keys-interpolate-along-the-route", () => {
      // Nodes at s = 0, 4, 10. The view is keyed at the last two, the x lead at
      // the first and last, the y lead nowhere: each field has its own keys,
      // and a node that keys nothing for a field is not on that field's track.
      const path: CameraPathData = {
        ...RIDE,
        verts: [
          { x: 0, y: 0, lookaheadX: 1 },
          { x: 4, y: 0, viewportScale: 2 },
          { x: 10, y: 0, viewportScale: 4, lookaheadX: 3 },
        ],
      };
      const rule = buildCameraRules([], [path])[0]!;
      if (rule.kind !== "path") return [{ label: "rule kind", got: 0, want: 1 }];
      const at = (s: number) => pathParamsAt(rule, s);
      const ss = (t: number) => t * t * (3 - 2 * t);
      return [
        // Held before the first key and past the last.
        { label: "view before its first key", got: at(0).viewportScale, want: 2 },
        { label: "view at its first key", got: at(4).viewportScale, want: 2 },
        { label: "view at its last key", got: at(10).viewportScale, want: 4 },
        { label: "view past the end", got: at(12).viewportScale, want: 4 },
        // Geometric between: 2 -> 4 passes through sqrt(8) at the midpoint.
        { label: "view halfway is geometric", got: at(7).viewportScale, want: Math.sqrt(8), tol: 1e-9 },
        // Smoothstepped by arc length, linearly for a length.
        { label: "x lead a fifth of the way", got: at(2).lookaheadX, want: 1 + 2 * ss(0.2), tol: 1e-9 },
        // The middle node keys the view and not the lead, so the lead's track
        // runs straight past it: no plateau, no kink, no restart.
        { label: "x lead is transparent to the unkeyed node", got: at(4).lookaheadX, want: 1 + 2 * ss(0.4), tol: 1e-9 },
        // A field nothing keys is the path-level one, everywhere.
        { label: "y lead is the path's", got: at(4).lookaheadY, want: 2.5 },
        { label: "y lead is the path's at the end", got: at(10).lookaheadY, want: 2.5 },
        // ...and one the path does not author either is the format's default.
        { label: "lead buffer is the default", got: at(4).lookaheadBufferX, want: 1 },
      ];
    }),

    run("keys-without-keys-are-the-path", () => {
      // The half every level on disk stands on: a path with no keys reads
      // exactly its own fields at every arc length.
      const rule = buildCameraRules([], [{ ...RIDE, viewportScale: 1.5 }])[0]!;
      if (rule.kind !== "path") return [{ label: "rule kind", got: 0, want: 1 }];
      return [0, 3, 10, 40].flatMap((s) => [
        { label: `view at ${s}`, got: pathParamsAt(rule, s).viewportScale, want: 1.5 },
        { label: `x lead at ${s}`, got: pathParamsAt(rule, s).lookaheadX, want: 2.5 },
      ]);
    }),

    run("keys-zoom-with-the-route", () => {
      // The view keyed 1 at the start and 4 at the end, ridden end to end: the
      // camera zooms from the base to a quarter of it, and past the end holds
      // the last key (the projection clamps, and the key holds anyway).
      const path: CameraPathData = {
        ...RIDE,
        // No deadband, so the lead origin IS the projection and the zoom at a
        // standstill is the key's exactly; `keys-are-read-at-the-lead-origin`
        // is where the band's own effect is asserted.
        lookaheadBufferX: 0,
        lookaheadBufferY: 0,
        verts: [
          { x: 0, y: 0, viewportScale: 1 },
          { x: 10, y: 0, viewportScale: 4 },
        ],
      };
      const rules = buildCameraRules([], [path]);
      const walk: Vec2[] = [];
      for (let i = 0; i < 120; i++) walk.push(new Vec2(0, 0));
      for (let i = 0; i < 300; i++) walk.push(new Vec2((10 * i) / 300, 0));
      for (let i = 0; i < 180; i++) walk.push(new Vec2(10, 0));
      // Past the end but inside the corridor, so the path keeps its grip.
      for (let i = 0; i < 180; i++) walk.push(new Vec2(10.5, 0));
      const out = ride(rules, walk);
      return [
        { label: "zoom at the start", got: out[119]!.zoom, want: BASE_ZOOM, tol: 1e-4 },
        { label: "zoom at the end", got: out[599]!.zoom, want: BASE_ZOOM / 4, tol: 1e-4 },
        { label: "zoom past the end", got: out[779]!.zoom, want: BASE_ZOOM / 4, tol: 1e-4 },
        // Monotone on the way: a zoom that overshoots or wobbles between two
        // keys is a kink in the interpolation.
        {
          label: "zoom never rises on the way out",
          got: out.slice(120, 600).some((o, i, arr) => i > 0 && o.zoom > arr[i - 1]!.zoom + 1e-12) ? 1 : 0,
          want: 0,
        },
      ];
    }),

    run("keys-are-read-at-the-lead-origin", () => {
      // A swing back and forth across a zoom gradient. Read at the raw
      // projection the zoom would pump every half-swing; read at the committed
      // lead origin, which the lookahead buffer holds still, it comes to rest.
      const keyed: CameraPathData = {
        ...RIDE,
        verts: [
          { x: 0, y: 0, viewportScale: 1 },
          { x: 10, y: 0, viewportScale: 4 },
        ],
      };
      const walk: Vec2[] = [];
      for (let i = 0; i < 300; i++) walk.push(new Vec2(5 + 0.4 * Math.sin(i / 4), 0));
      const held = ride(buildCameraRules([], [{ ...keyed, lookaheadBufferX: 1, lookaheadBufferY: 1 }]), walk);
      const loose = ride(buildCameraRules([], [{ ...keyed, lookaheadBufferX: 0, lookaheadBufferY: 0 }]), walk);
      return [
        { label: "the zoom really is on a gradient", got: held[0]!.zoom !== held[299]!.zoom || loose[0]!.zoom !== loose[299]!.zoom ? 1 : 0, want: 1 },
        { label: "zoom travel with the band", got: zoomTravel(held), want: 0, tol: 1e-6 },
        { label: "zoom travel without it", got: zoomTravel(loose) > 1e-3 ? 1 : 0, want: 1 },
      ];
    }),

    run("format-scales-path-keys", () => {
      // A node's lead keys are lengths and scale at the gate; its view key is a
      // ratio and does not.
      const raw: RawLevelData = {
        player: { x: 0, y: 0, radius: 20 },
        bodies: [],
        cameraPaths: [
          {
            x: 0,
            y: 0,
            rot: 0,
            verts: [
              { x: 0, y: 0, viewportScale: 2, lookaheadX: 250, lookaheadBufferY: 55, rangeX: 300, buffer: 20 },
              { x: 100, y: 0 },
            ],
          },
        ],
      };
      const v = scaleLevelData(raw, 0.01).cameraPaths![0]!.verts;
      return [
        { label: "view", got: v[0]!.viewportScale ?? NaN, want: 2 },
        { label: "x lead", got: v[0]!.lookaheadX ?? NaN, want: 2.5 },
        { label: "y lead buffer", got: v[0]!.lookaheadBufferY ?? NaN, want: 0.55 },
        { label: "x range", got: v[0]!.rangeX ?? NaN, want: 3 },
        { label: "buffer", got: v[0]!.buffer ?? NaN, want: 0.2 },
        { label: "absent stays absent", got: v[0]!.lookaheadY === undefined && v[1]!.viewportScale === undefined ? 1 : 0, want: 1 },
      ];
    }),

    // --- grip keys ----------------------------------------------------------
    //
    // Range, falloff and buffer are keyable too, and are read at the player's
    // PROJECTION rather than at the lead origin: the range is a statement about
    // the point on the route the player is nearest. The corridor the editor and
    // overlay draw is then a sweep of a varying ellipse, and the claim it has
    // to keep is the one the fixed-axis construction kept for free - that what
    // is drawn is exactly the zone tested.

    runFacts("grip-keys-are-read-at-the-projection", () => {
      // A corridor keyed 1 m wide at the start and 3 m at the end. The same
      // sideways offset is inside the range near the end and outside it near
      // the start, and the boundary is the smoothstep between - which a range
      // read anywhere but at the projection cannot reproduce.
      const path: CameraPathData = {
        ...RIDE,
        verts: [
          { x: 0, y: 0, rangeX: 1, rangeY: 1 },
          { x: 10, y: 0, rangeX: 3, rangeY: 3 },
        ],
      };
      const rules = buildCameraRules([], [path]);
      const ss = (t: number) => t * t * (3 - 2 * t);
      const bad: string[] = [];
      const at = (x: number, y: number) => activeCameraRule(rules, V(x, y)) === rules[0];
      // s = 2: range 1 + 2 * ss(0.2) = 1.208.
      if (!at(2, 1.2)) bad.push("1.2 m off at s = 2 should be inside a 1.208 m range");
      if (at(2, 1.3)) bad.push("1.3 m off at s = 2 should be outside a 1.208 m range");
      // s = 8: range 1 + 2 * ss(0.8) = 2.792.
      if (!at(8, 2.7)) bad.push("2.7 m off at s = 8 should be inside a 2.792 m range");
      if (at(8, 2.9)) bad.push("2.9 m off at s = 8 should be outside a 2.792 m range");
      // ...and the number itself, resolved through the rule.
      const r = rules[0]!;
      if (r.kind !== "path") return ["rule kind"];
      const want = 1 + 2 * ss(0.2);
      const got = pathRange(pathParamsAt(r, 2), V(0, 1));
      if (Math.abs(got - want) > 1e-9) bad.push(`range at s = 2: ${got} != ${want}`);
      return bad;
    }),

    runFacts("grip-keys-hold-by-the-keyed-buffer", () => {
      // The release hysteresis keyed wide at one end and narrow at the other:
      // a held path lets go at range + buffer, and the buffer it lets go by is
      // the one where the player is projected.
      const path: CameraPathData = {
        ...RIDE,
        lookaheadBufferX: 0,
        lookaheadBufferY: 0,
        verts: [
          { x: 0, y: 0, buffer: 1 },
          { x: 10, y: 0, buffer: 0 },
        ],
      };
      const rules = buildCameraRules([], [path]);
      // Acquire on the route near the start, then step 1.8 m off it: inside
      // range 1 + buffer ~1 there, so the grip holds. The same step near the
      // end, where the buffer is ~0, releases.
      const near = ride(rules, [V(0.5, 0), V(0.5, 0), V(0.5, 1.8), V(0.5, 1.8)]);
      const far = ride(rules, [V(9.5, 0), V(9.5, 0), V(9.5, 1.8), V(9.5, 1.8)]);
      const bad: string[] = [];
      if (near[3]!.rule !== rules[0]) bad.push("the wide-buffer end let go at 1.8 m");
      if (far[3]!.rule !== null) bad.push("the zero-buffer end held at 1.8 m");
      return bad;
    }),

    runFacts("corridor-sweep-is-the-zone-tested", () => {
      // The drawn boundary, point by point, against the predicate the
      // controller tests: every sample the sweep emits must sit ON the range
      // ellipse of its own projection (a straight route has no concave joint,
      // so nothing may be inside either), for a range that varies along it.
      const path: CameraPathData = {
        ...RIDE,
        verts: [
          { x: 0, y: 0, rangeX: 1, rangeY: 0.5 },
          { x: 4, y: 0 },
          { x: 10, y: 0, rangeX: 3, rangeY: 1.5 },
        ],
      };
      const rule = buildCameraRules([], [path])[0]!;
      if (rule.kind !== "path") return ["rule kind"];
      const pts = sweepPoints(rule);
      const bad: string[] = [];
      if (pts.length < 40) bad.push(`only ${pts.length} samples drawn`);
      let worst = 0;
      for (const p of pts) {
        const s = projectOntoPolyline(rule.index, p).s;
        const off = p.sub(pointAtArcLength(rule.index, s));
        const reach = pathRange(pathParamsAt(rule, s), off);
        worst = Math.max(worst, Math.abs(off.length() - reach));
      }
      if (worst > 1e-6) bad.push(`a drawn point is ${worst} m off the tested boundary`);
      // ...and it really does widen: the far end's samples reach 1.5 m off the
      // route where the near end's reach 0.5 m.
      const offAt = (x: number) => Math.max(...pts.filter((p) => Math.abs(p.x - x) < 0.3).map((p) => Math.abs(p.y)));
      if (Math.abs(offAt(0.5) - 0.5) > 0.05) bad.push(`near end reaches ${offAt(0.5)} m, want 0.5`);
      if (Math.abs(offAt(9.5) - 1.5) > 0.05) bad.push(`far end reaches ${offAt(9.5)} m, want 1.5`);
      return bad;
    }),

    runFacts("corridor-sweep-never-leaves-the-zone", () => {
      // On a route that bends, the inside of the bend is where a plain offset
      // curve grows a swallowtail, and with an ellipse that loop pokes OUTSIDE
      // the tested zone (19 cm here, before the pull-in). No drawn point may
      // sit outside; the pulled ones sit on the boundary within the bisection's
      // millimetre; and what is left of the loop - the part that was inside
      // all along - stays a small minority, drawn inside as an offset curve's
      // self-crossing always was.
      const path: CameraPathData = {
        ...RIDE,
        verts: [
          { x: 0, y: 0, rangeX: 1, rangeY: 0.6 },
          { x: 5, y: 0, outX: 1, outY: 0 },
          { x: 8, y: 4, inX: 0, inY: -1, rangeX: 2, rangeY: 1.2 },
        ],
      };
      const rule = buildCameraRules([], [path])[0]!;
      if (rule.kind !== "path") return ["rule kind"];
      const pts = sweepPoints(rule);
      let outside = 0;
      let loop = 0;
      let pulled = 0;
      for (const p of pts) {
        const s = projectOntoPolyline(rule.index, p).s;
        const off = p.sub(pointAtArcLength(rule.index, s));
        const reach = pathRange(pathParamsAt(rule, s), off);
        const d = off.length() - reach;
        if (d > 1e-6) outside++;
        else if (d < -2e-3) loop++;
        // A pulled-in point stops within the bisection's millimetre; an
        // untouched one is exact to rounding.
        else if (d < -1e-6) pulled++;
      }
      const bad: string[] = [];
      if (outside) bad.push(`${outside} of ${pts.length} drawn points lie outside the zone`);
      if (loop > pts.length * 0.15) bad.push(`${loop} of ${pts.length} drawn points are loop, not boundary`);
      // The case has to be one where the pull-in did something, or it says
      // nothing about the swallowtail.
      if (pulled === 0) bad.push("no point needed pulling in - the bend is not tight enough to be a test");
      return bad;
    }),

    runFacts("editor-key-round-trip", () => {
      // A keyed node survives the editor's own trip field for field, an unkeyed
      // one still writes its two coordinates and no more, and Reverse carries
      // each node's keys with the node.
      const authored: RawLevelData = {
        player: { x: 0, y: 0, radius: 20 },
        bodies: [],
        cameraPaths: [
          {
            x: 0,
            y: 0,
            rot: 0,
            verts: [
              { x: -300, y: 0, viewportScale: 1.5, lookaheadX: 120, rangeX: 500, falloffY: 70 },
              { x: 0, y: 0 },
              { x: 300, y: 0, lookaheadY: 90, lookaheadBufferX: 40, lookaheadBufferY: 30, rangeY: 150, falloffX: 60, buffer: 25 },
            ],
          },
        ],
      };
      const KEYS = [
        "viewportScale",
        "lookaheadX",
        "lookaheadY",
        "lookaheadBufferX",
        "lookaheadBufferY",
        "rangeX",
        "rangeY",
        "falloffX",
        "falloffY",
        "buffer",
      ] as const;
      const bad: string[] = [];
      const want = authored.cameraPaths![0]!;
      const compare = (out: CameraPathData, order: number[], label: string): void => {
        order.forEach((from, i) => {
          for (const k of KEYS) {
            const a = out.verts[i]?.[k];
            const b = want.verts[from]![k];
            if (a === undefined && b === undefined) continue;
            if (Math.abs((a ?? NaN) - (b ?? NaN)) > 1e-6) {
              bad.push(`${label}: vert ${i} ${k}: ${String(a)} != ${String(b)}`);
            }
          }
        });
      };
      const model = modelFromDisk(authored);
      const out = modelToDisk(model).cameraPaths?.[0];
      if (!out) return ["the path did not survive the round trip at all"];
      compare(out, [0, 1, 2], "round trip");
      const plain = Object.keys(out.verts[1] ?? {});
      if (plain.length !== 2 || !plain.includes("x") || !plain.includes("y")) {
        bad.push(`an unkeyed node wrote ${plain.join(",")}`);
      }
      const item = model.items.find((i) => i.shape.kind === "path");
      if (!item || !reversePathVerts(item)) return [...bad, "could not reverse the path"];
      const rev = modelToDisk(model).cameraPaths?.[0];
      if (!rev) return [...bad, "the reversed path did not survive"];
      compare(rev, [2, 1, 0], "reversed");
      return bad;
    }),
  ];
}
