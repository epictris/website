// WHERE THE EDITOR IS LOOKING, IN THE ADDRESS BAR: the level open and the view
// onto it, kept in the query string the way a map keeps its centre and zoom,
// so a reload - the dev server's, after an edit to the editor itself - comes
// back looking at the same corner of the same level instead of at the spawn.
//
//   /editor?level=ball&cam=12.5,-3.25,2&vis=12.5,3.25,0,0.3,-0.1,4.2&ws=visuals&lens=ortho
//
// `cam` is the Level workspace's view: the 2D camera's centre (sim metres, y
// down) and zoom, then the orbit's yaw and pitch (radians) when it is turned.
// `vis` is the Visuals workspace's pose, once it has one: its target (three's
// frame, y up), yaw, pitch and half height (metres) - the field of view is
// the level's lens, so it is not carried. `ws` names the workspace when it is
// Visuals, `lens` the lens when it is orthographic. Each workspace keeps its
// own view (see `setWorkspace`), so both are written, and a reload hands each
// back its own.
//
// Per tab, where the level last open (prefs.ts) is per browser: two tabs on
// two levels each reload onto their own. A value that does not parse is
// dropped on its own, so a hand-edited address costs only that field.

export interface LevelView {
  x: number;
  y: number;
  zoom: number;
  yaw: number;
  pitch: number;
}

export interface VisualsView {
  target: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  halfHeight: number;
}

export interface EditorView {
  level: string | null;
  cam: LevelView | null;
  vis: VisualsView | null;
  visualsActive: boolean;
  ortho: boolean;
}

// The zoom range the wheel allows (see the wheel handler), so an address can
// not open the editor anywhere the editor itself could not have been.
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 20;

function numbers(raw: string | null, counts: readonly number[]): number[] | null {
  if (raw === null) return null;
  const parts = raw.split(",");
  if (!counts.includes(parts.length)) return null;
  const out = parts.map(Number);
  return parts.every((p) => p.trim() !== "") && out.every(Number.isFinite) ? out : null;
}

export function readEditorView(search: string): EditorView {
  const q = new URLSearchParams(search);
  const c = numbers(q.get("cam"), [3, 5]);
  const v = numbers(q.get("vis"), [6]);
  return {
    level: q.get("level") || null,
    cam:
      c && c[2]! > 0
        ? {
            x: c[0]!,
            y: c[1]!,
            zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c[2]!)),
            yaw: c[3] ?? 0,
            pitch: c[4] ?? 0,
          }
        : null,
    vis:
      v && v[5]! > 0
        ? { target: { x: v[0]!, y: v[1]!, z: v[2]! }, yaw: v[3]!, pitch: v[4]!, halfHeight: v[5]! }
        : null,
    visualsActive: q.get("ws") === "visuals",
    ortho: q.get("lens") === "ortho",
  };
}

// Millimetres for a position, ten-thousandths of a radian for an angle, five
// figures for a scale: far below a pixel at any zoom the editor offers, and
// short enough to read.
const metres = (v: number): string => String(+v.toFixed(3));
const radians = (v: number): string => String(+v.toFixed(4));
const scale = (v: number): string => String(+v.toPrecision(5));

// `href` with the view written into its query string, every other parameter
// left as it was.
export function editorViewHref(href: string, view: EditorView): string {
  const url = new URL(href);
  const q = url.searchParams;
  const put = (key: string, value: string | null): void => {
    if (value === null) q.delete(key);
    else q.set(key, value);
  };
  put("level", view.level);
  const c = view.cam;
  put(
    "cam",
    c
      ? [metres(c.x), metres(c.y), scale(c.zoom), ...(c.yaw !== 0 || c.pitch !== 0 ? [radians(c.yaw), radians(c.pitch)] : [])].join(",")
      : null,
  );
  const v = view.vis;
  put(
    "vis",
    v
      ? [metres(v.target.x), metres(v.target.y), metres(v.target.z), radians(v.yaw), radians(v.pitch), scale(v.halfHeight)].join(",")
      : null,
  );
  put("ws", view.visualsActive ? "visuals" : null);
  put("lens", view.ortho ? "ortho" : null);
  // Commas are legal in a query string; left encoded they make it unreadable.
  url.search = q.toString().replace(/%2C/g, ",");
  return url.href;
}
