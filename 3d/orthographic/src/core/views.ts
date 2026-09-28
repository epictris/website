// The three orthographic views. Each maps world axes (0 = x, 1 = y, 2 = z) onto
// its horizontal and vertical screen axes.

import type { AxisName, Vec3, ViewId } from "./types";

export interface ViewDef {
  id: ViewId;
  name: string;
  title: string;
  /** [horizontal, vertical] world axis indices. */
  axes: [number, number];
  /** Direction the view looks along. */
  look: Vec3;
  description: string;
}

export const VIEW_IDS: ViewId[] = ["front", "top", "side"];
export const AXES: AxisName[] = ["x", "y", "z"];

export const VIEWS: Record<ViewId, ViewDef> = {
  front: {
    id: "front",
    name: "Front",
    title: "FRONT ELEVATION",
    axes: [0, 2],
    look: [0, 1, 0],
    description: "X / Z · looking along +Y",
  },
  top: {
    id: "top",
    name: "Top",
    title: "TOP PLAN",
    axes: [0, 1],
    look: [0, 0, -1],
    description: "X / Y · looking down −Z",
  },
  side: {
    id: "side",
    name: "Right side",
    title: "RIGHT-SIDE ELEVATION",
    axes: [1, 2],
    look: [-1, 0, 0],
    description: "Y / Z · looking along −X",
  },
};

export const axisNames = (view: ViewId): [AxisName, AxisName] => {
  const [a, b] = VIEWS[view].axes;
  return [AXES[a], AXES[b]];
};
