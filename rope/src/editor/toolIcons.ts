// THE TOOLBAR'S ICONS (editor/toolbar.ts): one 24-unit line-art vocabulary
// for every workspace's tools, drawn as Blender draws its toolbar - a light
// stroke in the text colour, and one accent (`--tool-accent`, filled or
// stroked: `.ac` / `.acf`) for the part of the picture that says what the
// tool makes. Inline SVG, so they inherit colour through `currentColor`,
// stay crisp at any DPI and look the same on every platform.
//
// Each icon appears at most once in the document, so the few that need a
// clip or a mask can name it.

export type ToolIconName =
  | "select"
  | "rect"
  | "circle"
  | "poly"
  | "curve"
  | "path"
  | "belt"
  | "cut"
  | "chain"
  | "vine"
  | "root"
  | "mushroom"
  | "glow"
  | "light"
  | "model"
  | "fog"
  | "shelter"
  | "track"
  | "text"
  | "arrow"
  | "checkpoint"
  | "addBox"
  | "addCylinder"
  | "union"
  | "subtract"
  | "intersect"
  | "sculptDraw"
  | "sculptGrab"
  | "moss"
  | "ivy"
  | "fern"
  | "hangingVine"
  | "mushrooms"
  | "orbs"
  | "glowFlora"
  | "paint";

// A small plus in the top-left corner: "adds a new one".
const PLUS = '<path class="ac" d="M5 1.5v6M2 4.5h6"/>';
const leaf = (x: number, y: number, rot: number, s = 1): string =>
  `<path class="acf" transform="translate(${x} ${y}) rotate(${rot}) scale(${s})" d="M0 0c1.6-1.8 4.2-1.8 5.2 0-1 1.8-3.6 1.8-5.2 0z"/>`;

const ICONS: Record<ToolIconName, string> = {
  // A dashed box and the pointer: Blender's Select Box.
  select:
    '<rect x="3" y="3" width="13" height="13" rx="1.5" stroke-dasharray="2.6 2.2"/><path class="acf" stroke-linejoin="round" d="M11.5 11.5 20 14.6l-3.7 1.5-1.5 3.7z"/>',
  rect: '<rect x="3.5" y="6.5" width="17" height="11" rx="1"/><path class="ac" d="M3.5 9.5v-3h3M20.5 14.5v3h-3"/>',
  circle: '<circle cx="12" cy="12" r="8"/><circle class="acf" cx="12" cy="12" r="1.6" stroke="none"/>',
  // An outline clicked out corner by corner, a notch and all.
  poly: '<path d="M4.5 18.5 6.5 6l6 3.5L18 4.5l1.5 14z"/><g class="acf" stroke="none"><circle cx="4.5" cy="18.5" r="1.7"/><circle cx="6.5" cy="6" r="1.7"/><circle cx="12.5" cy="9.5" r="1.7"/><circle cx="18" cy="4.5" r="1.7"/><circle cx="19.5" cy="18.5" r="1.7"/></g>',
  // A bar stroked along a Bezier curve: the scene layer's curve.
  curve: '<path stroke-width="3.2" d="M4 18c3-9 6-11 8-6s5 4 8-6"/><path class="ac" stroke-width="1" d="M4 18c3-9 6-11 8-6s5 4 8-6"/>',
  // ...and the camera layer's path: a route with a direction.
  path: '<path stroke-dasharray="2.4 2" d="M4 19c2-8 7-13 15-14"/><path class="acf" stroke-linejoin="round" d="m19 5-3.6-1.5.9 4.2z"/><circle class="acf" cx="4" cy="19" r="1.7" stroke="none"/>',
  // A band round two wheels, running.
  belt: '<circle cx="7" cy="12" r="3"/><circle cx="17" cy="12" r="3"/><path d="M7 7.5h10a4.5 4.5 0 0 1 0 9H7a4.5 4.5 0 0 1 0-9z"/><path class="ac" d="m11 5.5 2 2-2 2"/>',
  // A knife over a dashed cut.
  cut: '<path class="ac" stroke-dasharray="2.2 2" d="M3 21 21 3"/><path stroke-linejoin="round" d="M5.5 15.5 13 8l2.5 2.5c-2.5 3.5-6 5.8-10 5z"/><path stroke-width="2.6" d="m15 8 4.5-4.5"/>',
  // Two links, interlocked.
  chain: '<rect x="2.5" y="9" width="11" height="6" rx="3" transform="rotate(-45 8 12)"/><rect class="ac" x="10.5" y="9" width="11" height="6" rx="3" transform="rotate(-45 16 12)"/>',
  // A cord hung from an anchor, leaves along it.
  vine: `<circle cx="12" cy="3.5" r="1.5"/><path d="M12 5c-2.5 3-2.5 5 0 8s2.5 5 0 8"/>${leaf(12.3, 8.5, -30)}${leaf(11.4, 15.5, 200)}`,
  // A trunk forking into tapering roots.
  root: '<path stroke-width="2.6" d="M12 2.5V9"/><path stroke-width="2" d="M12 9c0 4-5 4.5-6.5 11M12 9c.3 4 4.5 5 6 9.5"/><path class="ac" d="M12 11v9.5M9 15.5 6 17"/>',
  // The bouncy mushroom: its cap, and the bounce over it.
  mushroom: '<path d="M4 15c0-5.5 16-5.5 16 0z"/><path d="M10 15v4.5c0 .8 4 .8 4 0V15"/><path class="ac" d="M7 7.5c2-4 8-4 10 0"/><path class="ac" d="m16 4.5 1 3-3 .3"/>',
  // The glowing mushroom: its cap, lit, and its light.
  glow: '<path class="acf" d="M5 15c0-5 14-5 14 0z"/><path d="M5 15c0-5 14-5 14 0z"/><path d="M10.2 15v4.5c0 .8 3.6 .8 3.6 0V15"/><path class="ac" d="M12 2.5v2.5M5.5 5l1.6 1.6M18.5 5l-1.6 1.6M3 10h1.8M19.2 10H21"/>',
  // A bulb, and what it throws.
  light: '<path d="M9.5 17.5h5M10.3 20.5h3.4M12 3.5a5.5 5.5 0 0 0-3.3 9.9c.6.5.9 1.2.9 2V16h4.8v-.6c0-.8.3-1.5.9-2A5.5 5.5 0 0 0 12 3.5z"/><path class="ac" d="M12 7.5a2 2 0 0 1 2 2"/>',
  // A model of the library: a box seen from above a corner.
  model: '<path stroke-linejoin="round" d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path stroke-linejoin="round" d="m4 7.5 8 4.5 8-4.5M12 12v9"/><path class="acf" stroke="none" d="m12 12 8-4.5v9L12 21z" opacity=".35"/>',
  fog: '<path d="M3 8c3-2 6 2 9 0s6-2 9 0M3 16c3-2 6 2 9 0s6-2 9 0"/><path class="ac" d="M5 12c2.5-1.6 5 1.6 7 0s4.5-1.6 7 0"/>',
  // A cave's front wall: the arch, and the sun it hides the cave from.
  shelter: '<path d="M3 20.5V13a9 9 0 0 1 18 0v7.5M3 20.5h18"/><path stroke-dasharray="1.8 1.8" d="M7.5 20.5V14a4.5 4.5 0 0 1 9 0v6.5"/><circle class="acf" cx="19" cy="4.5" r="2" stroke="none"/>',
  // A minecart on its rails: the rail and its sleepers, the cart's hopper and
  // its two wheels in the accent.
  track:
    '<path d="M2.5 19.5h19M5 19.5v2M10 19.5v2M15 19.5v2M20 19.5v2"/><path stroke-linejoin="round" d="M5 8.5h14l-1.5 7.5h-11z"/><g class="acf" stroke="none"><circle cx="8.5" cy="17" r="2"/><circle cx="15.5" cy="17" r="2"/></g>',
  text: '<path d="M5.5 5.5h13M12 5.5v13M9 18.5h6"/><path class="ac" d="M5.5 5.5v2M18.5 5.5v2"/>',
  arrow: '<path d="M5 19 18 6"/><path class="ac" stroke-linejoin="round" d="M10.5 5.5H18.5v8"/>',
  checkpoint: '<path d="M6.5 21V3.5"/><path class="acf" stroke-linejoin="round" d="M6.5 4h11l-2.5 4 2.5 4h-11z"/>',
  // Formations: a new guide, a box or a cylinder.
  addBox: `${PLUS}<path stroke-linejoin="round" d="m14 6 6.5 3.5v7L14 20l-6.5-3.5v-7z"/><path stroke-linejoin="round" d="m7.5 9.5 6.5 3.5 6.5-3.5M14 13v7"/>`,
  addCylinder: `${PLUS}<ellipse cx="14" cy="8.5" rx="5.5" ry="2.3"/><path d="M8.5 8.5v9c0 3 11 3 11 0v-9"/>`,
  // Combining guides: two circles, what is kept filled.
  union:
    '<g class="acf" stroke="none" opacity=".55"><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/></g><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>',
  subtract:
    '<defs><mask id="tb-subtract-mask"><rect width="24" height="24" fill="#fff"/><circle cx="15" cy="12" r="6" fill="#000"/></mask></defs><circle class="acf" cx="9" cy="12" r="6" stroke="none" opacity=".55" mask="url(#tb-subtract-mask)"/><circle cx="9" cy="12" r="6"/><circle stroke-dasharray="2 1.8" cx="15" cy="12" r="6"/>',
  intersect:
    '<defs><clipPath id="tb-intersect-clip"><circle cx="15" cy="12" r="6"/></clipPath></defs><circle class="acf" cx="9" cy="12" r="6" stroke="none" opacity=".55" clip-path="url(#tb-intersect-clip)"/><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>',
  // Sculpt: a surface raised under the brush, and one pulled.
  sculptDraw: '<path d="M3 18h4.5c2 0 2.2-6.5 4.5-6.5S14.5 18 16.5 18H21"/><path class="acf" stroke="none" d="M7.5 18c2 0 2.2-6.5 4.5-6.5S14.5 18 16.5 18z" opacity=".55"/><circle class="ac" cx="12" cy="6" r="3"/>',
  sculptGrab: '<path d="M3 19h5c1.5 0 2.2-4.5 4-4.5s2.5 4.5 4 4.5h5"/><path class="ac" d="M12 13V4M8.8 7.2 12 4l3.2 3.2"/>',
  // Decorations: moss painted on as a low clumped cushion.
  moss: '<path class="acf" stroke="none" opacity=".55" d="M3 17c0-3 2.6-4.2 4.6-3 .7-3.4 4.6-4 6-1 1.6-2.6 5.2-1.8 5.8 1 1.6-.4 2.6 1 2.6 3z"/><path d="M3 17c0-3 2.6-4.2 4.6-3 .7-3.4 4.6-4 6-1 1.6-2.6 5.2-1.8 5.8 1 1.6-.4 2.6 1 2.6 3z"/><path d="M2 20.5h20"/><path class="ac" d="M7 10.5V8M12 9V5.5M16.5 9.5V7.5"/>',
  // Ivy: a creeping stem and its three-pointed leaves.
  ivy: '<path d="M3 20c4-1 6-4 8-8s5-6 10-7"/><path class="acf" stroke-linejoin="round" d="M8.5 15.5c-2.8-.2-4-2.4-3-4.2 1 .2 1.6.8 2 1.6.2-1.8 1.4-2.8 2.8-2.6-.2 1.4.3 3.6-1.8 5.2z"/><path class="acf" stroke-linejoin="round" d="M15.2 9c-1-2.6.2-4.8 2.3-4.8.1 1-.2 1.8-.8 2.4 1.8-.3 3 .5 3.2 1.9-1.3.4-3.5.3-4.7.5z"/>',
  // A fern's frond: a curling stem, leaflets in pairs.
  fern: '<path d="M6 21c2-6 5-11 12-16"/><path class="ac" d="M8.5 15.5 5 14M8.5 15.5l2 3.2M11 11.5 7.5 9.5M11 11.5l2.8 2.8M13.8 8.4l-2.6-2.6M13.8 8.4l3.2 1.8"/>',
  // A vine hanging from a ledge, more than one strand.
  hangingVine: `<path d="M3 3.5h18"/><path d="M8 3.5c-1.6 3-1.6 5 0 8s1.6 4.5 0 7.5M15.5 3.5c1.4 2.6 1.4 4.6 0 7"/>${leaf(8.3, 7.8, -30, 0.9)}${leaf(7.5, 14.5, 200, 0.9)}${leaf(15.8, 8.6, -20, 0.9)}`,
  mushrooms: '<path d="M2.5 13c0-4.6 11-4.6 11 0z"/><path d="M6.5 13v5.5M9.5 13v5.5"/><path class="acf" d="M13 17.5c0-3 7.5-3 7.5 0z"/><path d="M15.7 17.5v3M17.8 17.5v3M2 21h20"/>',
  // Orbs on threads from a ledge.
  orbs: '<path d="M3 3.5h18M8 3.5v8M16 3.5v4.5"/><circle class="acf" cx="8" cy="14.5" r="3"/><circle class="acf" cx="16" cy="10.5" r="2.5"/>',
  // A sprout whose head glows.
  glowFlora: '<path d="M12 21v-9M12 16c-2.5 0-4-1.2-4.5-3.5 2.5 0 4 1.2 4.5 3.5z"/><circle class="acf" cx="12" cy="8.5" r="3"/><path class="ac" d="M12 2.5v1.3M6.2 4.6l1 1M17.8 4.6l-1 1M5 9h1.3M17.7 9H19"/>',
  // A brush, and the stroke it laid.
  paint: '<path class="ac" stroke-width="2.4" d="M3.5 19.5c2.5.5 4.5-.5 5.5-2.5"/><path stroke-linejoin="round" d="m9 13 2 2 9.5-9.5a1.4 1.4 0 0 0-2-2z"/><path stroke-linejoin="round" d="M9 13c-2 0-3 1.4-3 3.5 2 0 3.5-1 4-2.5"/>',
};

// The icon as markup, for a tool button's inside.
export function toolIcon(name: ToolIconName): string {
  return `<svg class="ed-tool-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">${ICONS[name]}</svg>`;
}
