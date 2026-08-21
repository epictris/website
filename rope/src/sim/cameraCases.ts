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
  CameraController,
  cameraRuleTarget,
  activeCameraRule,
  type CameraRule,
} from "../render/cameraController";
import type { CameraPathData, CameraRegionData, RawLevelData } from "../level/levelFormat";
import { scaleLevelData } from "../level/levelFormat";
import { modelFromDisk, modelToDisk } from "../editor/model";
import {
  buildPolylineIndex,
  cubicAt,
  flattenPath,
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
  range: 1,
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
): { pos: Vec2; rule: CameraRule | null; s: number; leadS: number }[] {
  const ctl = new CameraController();
  const cam = stubCamera();
  return walk.map((p) => {
    ctl.update(cam, DT, p, rules, BASE_ZOOM);
    const held = ctl.held;
    return { pos: cam.position, rule: held.rule, s: held.s, leadS: held.leadS };
  });
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
            range: 350,
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
        "range",
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
  ];
}
