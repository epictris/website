// World units are metres. The physics engine, level geometry, and every tuning
// constant are expressed in metres and seconds (or per-frame at the fixed 1/60
// step) — never pixels. Pixels exist only at the edges: rendering to the canvas
// and un-projecting pointer input.
//
// PIXELS_PER_METER is the single conversion between the two. It is chosen so the
// ported Godot gravity (980 px/s²) reads as the real-world 9.8 m/s²; every other
// constant followed from the same ÷100. Because it is applied symmetrically
// (÷ on the way in — level import, input — and × on the way out — rendering),
// changing it is an invisible reparametrization: it only changes which numbers
// the constants read as, never the simulation's behaviour or its appearance.
//
// To rescale how large the world appears on screen, change `camera.zoom`
// instead — that is the view knob, and the physics engine never sees it.
export const PIXELS_PER_METER = 100;

// Metres per pixel — for expressing a fixed on-screen pixel size (line widths,
// glyph-scale decoration) as a world-space length inside the camera transform.
export const PX = 1 / PIXELS_PER_METER;
