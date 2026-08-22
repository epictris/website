// Spark events - the one thing the simulation contributes to the hook's sparks,
// and the whole of the boundary between the two.
//
// Steel on hook-proof steel throws sparks, and sparks affect nothing: they light
// no scenery, push no body, and are never asked about. So none of them exist in
// the sim. What exists is a per-frame list of plain contact facts the sim had in
// hand anyway - where, which way the surface faces, how fast the hook was going
// - which the render side turns into particles with its own PRNG, its own
// thresholds and its own clock.
//
// The list is CLEARED at the top of every `physicsProcess` rather than when a
// renderer consumes it: headless replay (`cli replay`, `cli bundles`,
// playtests) steps the level with nothing attached, and an append-only list
// would grow for the length of a bundle. A frame's events live exactly one
// frame; a tool that never looks loses nothing, and nothing in the sim reads
// them back.

import type { Vec2 } from "../engine/vec2";

// One touch between the hook and a hook-proof surface, as three vectors.
//
// There is deliberately no field saying WHICH touch it was - a bounce, a solver
// contact, a grapple hook being destroyed - because the render side must not
// branch on that, and a field whose only correct use is "ignore me" is one
// somebody eventually branches on. It was written that way first and the drag
// case is what it cost: a dangling tip dragged along a wall reports through
// `bounce()` on every frame with its velocity almost entirely TANGENTIAL, so
// reading those events as "an impact, therefore a burst" threw the whole slide
// away and the tip ground along the steel in silence.
//
// The burst and the stream are both properties of this one velocity, split at
// the surface: the normal component says how hard it hit, the tangential one
// how fast it is travelling along the face. Every event is asked both
// questions and each answers independently, which is what makes a head-on hit
// a burst, a drag a stream, and a glancing skip both.
export interface SparkEvent {
  // World metres - the contact point.
  point: Vec2;
  // Out of the surface.
  normal: Vec2;
  // The hook's velocity at the contact, m/s. Where a bounce reports it, this is
  // the PRE-reflection velocity: the speed the hook arrived at is what the hit
  // looked like.
  vel: Vec2;
}
