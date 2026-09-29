// Off-screen pictures of the scene: each orthographic view as SVG or PNG, and
// the perspective camera frame as PNG. Used by exports and the agent API.

import { unwrap } from "solid-js/store";
import { render } from "solid-js/web";
import { dataUrl, image as imageOf } from "./assets";
import { fmt, lengthText } from "./core/math";
import { MARGIN_PX, type Projection, pictureBox, projection, roundScale } from "./core/projection";
import type { EditorState, ViewId } from "./core/types";
import { VIEW_IDS, VIEWS } from "./core/views";
import { settle } from "./meshes";
import { windowFrame } from "./ortho/frame";
import { OrthoScene } from "./ortho/OrthoScene";
import { overlayGeometry, perspectiveRenderer, renderInput } from "./perspective/PerspectiveView";
import { state } from "./store";

export interface OrthoSnapshotOptions {
  /** Draw the view's reference image when one is assigned (default true, even if hidden in the editor). */
  references?: boolean;
  labels?: boolean;
  grid?: boolean;
}

/** One orthographic view's picture at the projection's shared scale, as standalone SVG markup. */
export function orthoSvg(view: ViewId, p: Projection, opts: OrthoSnapshotOptions = {}): string {
  const w = p.views[view];
  const s = unwrap(state) as EditorState;
  const frame = windowFrame(w, p.pixelsPerMeter);
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
        showScaleBar={opts.labels !== false}
        showBounds={false}
        exportMode
        imageHref={dataUrl}
      />
    ),
    holder,
  );
  const body = holder.innerHTML;
  dispose();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w.width}" height="${w.height}" viewBox="0 0 ${w.width} ${w.height}">${body}</svg>`;
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

export async function orthoPng(view: ViewId, p: Projection, opts: OrthoSnapshotOptions = {}): Promise<string> {
  return svgToPng(orthoSvg(view, p, opts), p.views[view].width, p.views[view].height);
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
    const ref = state.references.perspective;
    const a = imageOf(ref?.image);
    const overlaid = !!(ref && a && opts.references !== false);
    // As in the editor: over the reference, the solids' outlines on top at full opacity.
    const outlines = overlaid ? document.createElement("canvas") : undefined;
    r.render({ ...renderInput(), selected: () => false }, outlines);
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d")!;
    ctx.drawImage(canvas, 0, 0);
    if (ref && a && overlaid) {
      const g = overlayGeometry(w, h, ref, a);
      ctx.save();
      ctx.globalAlpha = ref.opacity;
      ctx.globalCompositeOperation = ref.blend === "normal" ? "source-over" : ref.blend;
      ctx.translate(g.cx, g.cy);
      ctx.rotate(g.radians);
      ctx.drawImage(a.element, -g.width / 2, -g.height / 2, g.width, g.height);
      ctx.restore();
      if (outlines) ctx.drawImage(outlines, 0, 0);
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

/**
 * All three views on one sheet at one scale, in third-angle projection: the
 * plan above the front elevation, the right side to its right, so shared axes
 * line up across views. The scene document is in the SVG metadata.
 */
export function projectionSheet(metadata: unknown): string {
  const s = unwrap(state) as EditorState;
  const pad = 30;
  const gap = 24;
  const head = 40;
  const top = 128;
  const foot = 56;
  const b = pictureBox(s);
  const ext = [0, 1, 2].map((a) => b.max[a] - b.min[a]);
  // The largest round scale that keeps the drawing within about 2400 x 1800 px.
  const ppm = roundScale(
    Math.min(
      (2400 - 2 * pad - gap - 4 * MARGIN_PX) / (ext[0] + ext[1]),
      (1800 - top - 2 * head - gap - foot - 4 * MARGIN_PX) / (ext[1] + ext[2]),
    ),
  );
  const p = projection(s, { pixelsPerMeter: ppm });
  if (typeof p === "string") throw new Error(p);
  const { front, side } = p.views;
  const col = [pad, pad + front.width + gap];
  const row = [top, top + head + p.views.top.height + gap];
  const cells: Record<ViewId, [number, number]> = {
    top: [col[0], row[0]],
    front: [col[0], row[1]],
    side: [col[1], row[1]],
  };
  const sheetW = Math.max(col[1] + side.width + pad, 1000);
  const sheetH = row[1] + head + front.height + foot;
  const basis = s.scene.scaleBasis.trim();
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}" viewBox="0 0 ${sheetW} ${sheetH}" font-family="Arial, sans-serif">`,
    `<metadata>${esc(JSON.stringify(metadata))}</metadata><rect width="100%" height="100%" fill="#091321"/>`,
    `<text x="34" y="45" fill="#deedf7" font-size="28" font-weight="700">${esc(s.scene.title)} · orthographic views</text>`,
    `<text x="35" y="75" fill="#8eaac1" font-size="15">Third-angle projection, every view at one scale: ${fmt(ppm, 6)} px = 1 m (1 px = ${lengthText(1 / ppm)}) · lengths in metres</text>`,
    `<text x="35" y="100" fill="${basis ? "#8eaac1" : "#e2c16d"}" font-size="15">Scale basis: ${esc(basis ? (basis.length > 180 ? `${basis.slice(0, 179)}…` : basis) : "not set")}</text>`,
  ];
  for (const view of VIEW_IDS) {
    const w = p.views[view];
    const [x, y] = cells[view];
    const inner = orthoSvg(view, p, { references: false }).replace(/^<svg[^>]*>|<\/svg>$/g, "");
    out.push(
      `<g transform="translate(${x},${y})"><clipPath id="panel-${view}"><rect width="${w.width}" height="${head + w.height}" rx="8"/></clipPath>`,
      `<g clip-path="url(#panel-${view})"><rect width="${w.width}" height="${head + w.height}" fill="#0b1625"/>`,
      `<svg y="${head}" width="${w.width}" height="${w.height}" viewBox="0 0 ${w.width} ${w.height}">${inner}</svg></g>`,
      `<rect width="${w.width}" height="${head + w.height}" rx="8" fill="none" stroke="#30475f"/>`,
      `<text x="16" y="26" font-size="17" font-weight="700" fill="#dfedf7">${VIEWS[view].title}</text>`,
      // A narrow view keeps its title only.
      w.width >= 460
        ? `<text x="${w.width - 16}" y="26" font-size="12" fill="#8eaac1" text-anchor="end">${esc(VIEWS[view].description)}</text>`
        : "",
      `<line x1="0" y1="${head}" x2="${w.width}" y2="${head}" stroke="#30475f"/></g>`,
    );
  }
  out.push(
    `<text x="35" y="${sheetH - 30}" fill="#abc4d9" font-size="14">Coordinates: X right, Y depth away from the front camera, Z up. Front = XZ; top = XY; right side = YZ. The scene document is in this file's metadata.</text>`,
    `<text x="${sheetW - 30}" y="${sheetH - 12}" fill="#839eb5" font-size="12" text-anchor="end">${new Date().toISOString().slice(0, 10)}</text></svg>`,
  );
  return out.join("");
}
