// Off-screen pictures of the scene: each orthographic view as SVG or PNG, and
// the perspective camera frame as PNG. Used by exports and the agent API.

import { unwrap } from "solid-js/store";
import { render } from "solid-js/web";
import { dataUrl, image as imageOf } from "./assets";
import { fmt } from "./core/math";
import { sceneBounds } from "./core/model";
import type { EditorState, ViewId } from "./core/types";
import { VIEW_IDS, VIEWS } from "./core/views";
import { settle } from "./meshes";
import { fitCamera, frameOf } from "./ortho/frame";
import { OrthoScene } from "./ortho/OrthoScene";
import { overlayGeometry, perspectiveRenderer, renderInput } from "./perspective/PerspectiveView";
import { state } from "./store";

export interface OrthoSnapshotOptions {
  width?: number;
  height?: number;
  /** Draw the view's reference image when one is assigned (default true, even if hidden in the editor). */
  references?: boolean;
  labels?: boolean;
  grid?: boolean;
}

/** One orthographic view, fitted to the scene, as standalone SVG markup. */
export function orthoSvg(view: ViewId, opts: OrthoSnapshotOptions = {}): string {
  const W = opts.width ?? 1200;
  const H = opts.height ?? 900;
  const s = unwrap(state) as EditorState;
  const frame = frameOf(fitCamera(view, sceneBounds(s), W, H), W, H);
  const holder = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  // A reference is drawn whenever one is assigned (even if hidden in the editor), unless references is false.
  const r = s.references[view];
  const view_ = {
    ...s,
    references: { ...s.references, [view]: opts.references === false || !r ? null : { ...r, visible: true } },
  };
  const dispose = render(
    () => (
      <OrthoScene
        view={view}
        frame={frame}
        state={view_}
        items={s.objects.filter((e) => e.visible)}
        selected={() => false}
        showGrid={opts.grid !== false}
        showLabels={opts.labels !== false}
        showBounds={false}
        exportMode
        imageHref={dataUrl}
      />
    ),
    holder,
  );
  const body = holder.innerHTML;
  dispose();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
}

async function svgToPng(svg: string, W: number, H: number): Promise<string> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    canvas.getContext("2d")!.drawImage(img, 0, 0, W, H);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function orthoPng(view: ViewId, opts: OrthoSnapshotOptions = {}): Promise<string> {
  return svgToPng(orthoSvg(view, opts), opts.width ?? 1200, opts.height ?? 900);
}

/** The perspective camera frame as a canvas, with the reference overlay unless references is false. */
export async function perspectiveCanvas(
  opts: { width?: number; references?: boolean } = {},
): Promise<HTMLCanvasElement> {
  const r = perspectiveRenderer();
  if (!r) throw new Error("3D rendering is unavailable in this browser.");
  await settle();
  const c = state.camera;
  const w = opts.width ?? c.frame[0];
  const h = Math.round((w * c.frame[1]) / c.frame[0]);
  const canvas = r.canvas;
  const old = [canvas.width, canvas.height];
  try {
    canvas.width = w;
    canvas.height = h;
    r.render({ ...renderInput(), selected: () => false });
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d")!;
    ctx.drawImage(canvas, 0, 0);
    const ref = state.references.perspective;
    const a = imageOf(ref?.image);
    if (ref && a && opts.references !== false) {
      const g = overlayGeometry(w, h, ref, a);
      ctx.save();
      ctx.globalAlpha = ref.opacity;
      ctx.globalCompositeOperation = ref.blend === "normal" ? "source-over" : ref.blend;
      ctx.translate(g.cx, g.cy);
      ctx.rotate(g.radians);
      ctx.drawImage(a.element, -g.width / 2, -g.height / 2, g.width, g.height);
      ctx.restore();
    }
    return out;
  } finally {
    canvas.width = old[0];
    canvas.height = old[1];
    r.render(renderInput());
  }
}

export async function perspectivePng(opts: { width?: number; references?: boolean } = {}): Promise<string> {
  return (await perspectiveCanvas(opts)).toDataURL("image/png");
}

const esc = (x: string) =>
  x.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** All three views on one sheet, with the scene document in the SVG metadata. */
export function projectionSheet(metadata: unknown): string {
  const sheetW = 2200;
  const sheetH = 1760;
  const layouts: Record<ViewId, { x: number; y: number; w: number; h: number }> = {
    front: { x: 30, y: 135, w: 2140, h: 710 },
    top: { x: 30, y: 865, w: 1060, h: 795 },
    side: { x: 1110, y: 865, w: 1060, h: 795 },
  };
  const m = state.scene.metersPerUnit;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}" viewBox="0 0 ${sheetW} ${sheetH}" font-family="Arial, sans-serif">`,
    `<metadata>${esc(JSON.stringify(metadata))}</metadata><rect width="100%" height="100%" fill="#091321"/>`,
    `<text x="34" y="45" fill="#deedf7" font-size="28" font-weight="700">${esc(state.scene.title)} · orthographic views</text>`,
    `<text x="35" y="75" fill="#8eaac1" font-size="15">Linked X / Y / Z layout · scene units (u) · ${m ? `1 u = ${fmt(m, 6)} m` : "no real-world scale"}</text>`,
  ];
  for (const view of VIEW_IDS) {
    const l = layouts[view];
    const W = l.w - 30;
    const H = l.h - 75;
    const inner = orthoSvg(view, { width: W, height: H, references: false }).replace(/^<svg[^>]*>|<\/svg>$/g, "");
    out.push(
      `<g transform="translate(${l.x},${l.y})"><rect width="${l.w}" height="${l.h}" rx="8" fill="#0b1625" stroke="#30475f"/>`,
      `<text x="20" y="31" font-size="19" font-weight="700" fill="#dfedf7">${VIEWS[view].title}</text>`,
      `<text x="${l.w - 20}" y="30" font-size="12" fill="#8eaac1" text-anchor="end">${esc(VIEWS[view].description)}</text>`,
      `<svg x="15" y="48" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${inner}</svg></g>`,
    );
  }
  out.push(
    `<text x="35" y="1712" fill="#abc4d9" font-size="14">Coordinates: X right, Y depth away from the front camera, Z up. Front = XZ; top = XY; right side = YZ. The scene document is in this file's metadata.</text>`,
    `<text x="2160" y="1730" fill="#839eb5" font-size="12" text-anchor="end">${new Date().toISOString().slice(0, 10)}</text></svg>`,
  );
  return out.join("");
}
