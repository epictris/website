// Keyframes along a path: a field whose value changes with WHERE something is
// on a route rather than with when.
//
// Two things read these and they read them the same way. A camera path keys its
// framing (`CameraPathVert` - a tighter view through a corridor, a longer lead
// down a drop), and a body's travel route keys its pose and its pace
// (`MoveNodeData` - a minecart that noses over and picks up speed on the
// descent). What is shared is the whole shape of the idea:
//
//   - a key rides an authored NODE rather than an arc length, because a node is
//     what the editor picks, drags, inserts, deletes and reverses, and a key at
//     `s = 12.3` names a different place the moment any node before it moves;
//   - a node that carries a value keys THAT field only, and one that carries
//     none is transparent to it;
//   - a field no node keys at all is the path-level field, so a path authored
//     before keys existed is unchanged everywhere along its length;
//   - and between two keys the value is smoothstepped BY ARC LENGTH, flat at
//     each key - a kink in a keyed value is a step in something's velocity,
//     whether that is the camera's or a platform's.
//
// A node's arc length is only known once the curve into it is flattened, which
// is why a track is built alongside the polyline index (`PolylineIndex.nodeS`)
// and not from the node list alone.

// One field's keys in arc-length order. Empty = no node keys the field.
import { dmath } from "../engine/dmath";

export type KeyTrack = readonly { s: number; v: number }[];

// The interpolation between two keys of a field. Linear is the default and what
// every length uses; a zoom interpolates GEOMETRICALLY (1 -> 4 passes through 2)
// because that is what every other zoom blend here does.
export type KeyBlend = (a: number, b: number, t: number) => number;

export const smoothstep = (t: number): number => t * t * (3 - 2 * t);

export const lerpKey: KeyBlend = (a, b, t) => a + (b - a) * t;

export const lerpZoom: KeyBlend = (a, b, t) =>
  dmath.exp(dmath.log(Math.max(1e-6, a)) * (1 - t) + dmath.log(Math.max(1e-6, b)) * t);

// One field's track: the nodes that carry a value, placed at the arc lengths
// those nodes landed at.
//
// `values[i]` is node i's key for the field - `undefined` or `null` for a node
// that does not key it - and `nodeS[i]` is where node i sits along the route. A
// node the index knows nothing about (a track built against a bare polyline,
// which reports no node positions) keys nothing rather than keying at zero.
export function buildKeyTrack(
  values: readonly (number | undefined | null)[],
  nodeS: readonly number[],
): { s: number; v: number }[] {
  const track: { s: number; v: number }[] = [];
  values.forEach((v, i) => {
    const s = nodeS[i];
    if (v !== undefined && v !== null && s !== undefined) track.push({ s, v });
  });
  // Arc length is monotone in node order for every route this can be built
  // from, so the sort is a guarantee rather than a fix - and it is what lets
  // the lookup below be a plain walk.
  return track.sort((a, b) => a.s - b.s);
}

// A field's value at arc length `s`.
//
// No keys is `fallback`, the path-level value. Before the first key it holds
// that key and past the last it holds that one - a key states what the value IS
// there, and there is nothing beyond the ends of the route to blend toward.
// Between two it is smoothstepped by arc length, flat at each key.
//
// Two keys at the same arc length (coincident nodes) take the later one, which
// is what the walk below falls out to.
export function keyValueAt(
  track: KeyTrack,
  s: number,
  fallback: number,
  blend: KeyBlend = lerpKey,
): number {
  if (track.length === 0) return fallback;
  if (s <= track[0]!.s) return track[0]!.v;
  const last = track[track.length - 1]!;
  if (s >= last.s) return last.v;
  let i = 0;
  while (track[i + 1]!.s <= s) i++;
  const a = track[i]!;
  const b = track[i + 1]!;
  const span = b.s - a.s;
  return span > 0 ? blend(a.v, b.v, smoothstep((s - a.s) / span)) : b.v;
}
