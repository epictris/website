// The drawing of one orthographic view as SVG content: backdrop, reference
// image, grid, scene frame, outlines, labels and scale bar. Used live by
// OrthoView and off-screen for exports and agent renders.

import { createMemo, For, type JSX, Show } from "solid-js";
import { image, type LoadedImage } from "../assets";
import { fmt, lengthText, niceStep } from "../core/math";
import type { EditorState, SceneObject, ViewId } from "../core/types";
import { VIEWS } from "../core/views";
import { type Frame, layoutLabels, objectScreenBox, outlinePath, type Rect, toScreen } from "./frame";

export interface OrthoSceneProps {
  view: ViewId;
  frame: Frame;
  state: EditorState;
  items: SceneObject[];
  selected: (id: string) => boolean;
  showGrid: boolean;
  showLabels: boolean;
  showBounds: boolean;
  /** Draw the scale bar (default true). */
  showScaleBar?: boolean;
  /** Export drawings leave out hit targets and selection emphasis. */
  exportMode?: boolean;
  /** How the reference image is addressed; exports inline it as a data URL. */
  imageHref?: (a: LoadedImage) => string;
  /** Screen areas labels should avoid (the selection's dimension labels). */
  reserved?: Rect[];
  children?: JSX.Element;
}

function Grid(props: { frame: Frame }) {
  const lines = createMemo(() => {
    const f = props.frame;
    const major = niceStep(64 / f.s);
    const minor = major / 5;
    const minU = -f.tx / f.s;
    const maxU = (f.W - f.tx) / f.s;
    const minV = (f.ty - f.H) / f.s;
    const maxV = f.ty / f.s;
    const out = {
      minor: "",
      major: "",
      axis: "",
      labels: [] as { x: number; y: number; text: string; anchor: "middle" | "start" }[],
    };
    for (const [step, isMinor] of [
      [minor, true],
      [major, false],
    ] as const) {
      if (isMinor && step * f.s < 7) continue;
      let count = 0;
      for (let k = Math.ceil(minU / step); k <= Math.floor(maxU / step) && count < 1200; k++, count++) {
        const u = k * step;
        const x = (f.tx + u * f.s).toFixed(2);
        const d = `M${x},0V${f.H}`;
        if (Math.abs(u) < 1e-8) out.axis += d;
        else if (isMinor) out.minor += d;
        else out.major += d;
        if (!isMinor && +x > 23 && +x < f.W - 13)
          out.labels.push({ x: +x, y: f.H - 7, text: fmt(u, 6), anchor: "middle" });
      }
      count = 0;
      for (let k = Math.ceil(minV / step); k <= Math.floor(maxV / step) && count < 1200; k++, count++) {
        const v = k * step;
        const y = (f.ty - v * f.s).toFixed(2);
        const d = `M0,${y}H${f.W}`;
        if (Math.abs(v) < 1e-8) out.axis += d;
        else if (isMinor) out.minor += d;
        else out.major += d;
        // Vertical-axis labels sit at the left edge, where the scale bar covers the bottom 50 px.
        if (!isMinor && +y > 15 && +y < f.H - 50)
          out.labels.push({ x: 5, y: +y - 4, text: fmt(v, 6), anchor: "start" });
      }
    }
    return out;
  });
  return (
    <g pointer-events="none" font-family="monospace">
      <path d={lines().minor} stroke="#132438" stroke-width=".6" />
      <path d={lines().major} stroke="#20364c" stroke-width=".6" />
      <path d={lines().axis} stroke="#466176" stroke-width="1.1" />
      <For each={lines().labels}>
        {(l) => (
          <text x={l.x} y={l.y} text-anchor={l.anchor} fill="#6d89a2" font-size="9">
            {l.text}
          </text>
        )}
      </For>
    </g>
  );
}

function ScaleBar(props: { frame: Frame }) {
  const bar = createMemo(() => {
    const f = props.frame;
    let length = niceStep(75 / f.s);
    if (length * f.s > 130) length /= 2;
    return { length, pixels: length * f.s, x: 14, y: f.H - 16 };
  });
  return (
    <g pointer-events="none" font-family="monospace" font-size="9">
      <rect
        x="7"
        y={bar().y - 17}
        width={Math.max(bar().pixels + 28, 90)}
        height="26"
        rx="4"
        fill="#0b1625"
        fill-opacity=".94"
      />
      <path
        d={`M${bar().x},${bar().y}h${bar().pixels} M${bar().x},${bar().y - 4}v8 M${bar().x + bar().pixels / 2},${bar().y - 3}v6 M${bar().x + bar().pixels},${bar().y - 4}v8`}
        fill="none"
        stroke="#c0d5e7"
        stroke-width="1"
      />
      <text x={bar().x} y={bar().y - 7} fill="#c0d5e7">
        0
      </text>
      <text x={bar().x + bar().pixels} y={bar().y - 7} text-anchor="end" fill="#c0d5e7">
        {lengthText(bar().length)}
      </text>
    </g>
  );
}

export function OrthoScene(props: OrthoSceneProps) {
  const reference = createMemo(() => {
    const r = props.state.references[props.view];
    const a = r?.visible ? image(r.image) : undefined;
    if (!r || !a) return null;
    const p = toScreen(props.frame, r.min[0], r.min[1] + r.size[1]);
    return {
      href: props.imageHref ? props.imageHref(a) : a.url,
      x: p[0],
      y: p[1],
      w: r.size[0] * props.frame.s,
      h: r.size[1] * props.frame.s,
      opacity: r.opacity,
    };
  });
  const sceneRect = createMemo(() => {
    const [a, b] = VIEWS[props.view].axes;
    const size = props.state.scene.size;
    const p = toScreen(props.frame, 0, size[b]);
    return { x: p[0], y: p[1], w: size[a] * props.frame.s, h: size[b] * props.frame.s };
  });
  // Larger silhouettes first so small ones stay on top; the selection last.
  const ordered = createMemo(() => {
    const [i, j] = VIEWS[props.view].axes;
    return [...props.items].sort((a, b) => {
      if (!props.exportMode && props.selected(a.id) !== props.selected(b.id)) return props.selected(a.id) ? 1 : -1;
      return b.size[i] * b.size[j] - a.size[i] * a.size[j];
    });
  });
  const labels = createMemo(() =>
    props.showLabels
      ? layoutLabels(
          props.frame,
          props.view,
          props.items,
          (id) => !props.exportMode && props.selected(id),
          props.reserved,
        )
      : [],
  );
  return (
    <>
      <rect width={props.frame.W} height={props.frame.H} fill="#0b1625" />
      <Show when={reference()}>
        {(r) => (
          <image
            href={r().href}
            x={r().x}
            y={r().y}
            width={r().w}
            height={r().h}
            opacity={r().opacity}
            preserveAspectRatio="none"
            pointer-events="none"
          />
        )}
      </Show>
      <Show when={props.showGrid}>
        <Grid frame={props.frame} />
      </Show>
      <rect
        x={sceneRect().x}
        y={sceneRect().y}
        width={sceneRect().w}
        height={sceneRect().h}
        fill="none"
        stroke="#678999"
        stroke-opacity=".45"
        stroke-width=".85"
        stroke-dasharray="8 5"
        pointer-events="none"
      />
      <For each={ordered()}>
        {(e) => {
          const d = () => outlinePath(props.frame, props.view, e);
          const sel = () => !props.exportMode && props.selected(e.id);
          return (
            <g data-feature={e.id}>
              <path
                class={`feature-shape${e.locked ? " locked-shape" : ""}`}
                data-id={e.id}
                d={d()}
                fill={e.color}
                fill-opacity={sel() ? 0.13 : 0.035}
                stroke={e.color}
                stroke-opacity={e.locked ? 0.42 : sel() ? 1 : 0.78}
                stroke-width={sel() ? 2 : 1.2}
                stroke-linejoin="round"
              />
              <Show when={!props.exportMode}>
                {/* A transparent, wider hit target; not a second outline. */}
                <path
                  class="feature-hit"
                  data-id={e.id}
                  d={d()}
                  fill="transparent"
                  stroke="transparent"
                  stroke-width="10"
                />
              </Show>
              <Show when={props.showBounds}>
                {(() => {
                  const s = () => objectScreenBox(props.frame, props.view, e);
                  return (
                    <rect
                      x={s().left}
                      y={s().top}
                      width={s().width}
                      height={s().height}
                      fill="none"
                      stroke={e.color}
                      stroke-opacity=".3"
                      stroke-dasharray="3 5"
                      pointer-events="none"
                    />
                  );
                })()}
              </Show>
            </g>
          );
        }}
      </For>
      <For each={labels()}>
        {(l) => (
          <>
            <Show when={l.leader}>
              {(ln) => (
                <path
                  d={`M${ln()[0][0]},${ln()[0][1]}L${ln()[1][0]},${ln()[1][1]}`}
                  fill="none"
                  stroke={l.color}
                  stroke-opacity=".38"
                  stroke-width=".75"
                  pointer-events="none"
                />
              )}
            </Show>
            <g class="feature-label" data-id={l.id}>
              <rect
                x={l.x}
                y={l.y}
                width={l.w}
                height={l.h}
                rx="3"
                fill="#0a1524"
                fill-opacity=".96"
                stroke={l.color}
                stroke-opacity={l.selected ? 1 : 0.48}
                stroke-width=".8"
              />
              <text
                x={l.x + l.w / 2}
                y={l.y + 11.9}
                text-anchor="middle"
                font-family="monospace"
                font-weight="700"
                font-size="10.5"
                fill={l.color}
              >
                {l.id}
              </text>
            </g>
          </>
        )}
      </For>
      {props.children}
      <Show when={props.showScaleBar !== false}>
        <ScaleBar frame={props.frame} />
      </Show>
    </>
  );
}
