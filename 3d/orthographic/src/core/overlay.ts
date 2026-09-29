// Where the perspective reference image lies on the camera frame, and the
// mapping between its pixels and the frame's. Traces are stored in the image's
// own pixels, so they stay put when the overlay is moved, scaled or rotated.

import type { PerspectiveReference, Point } from "./types";

export interface ImageSize {
  width: number;
  height: number;
}

export interface OverlayGeometry {
  /** The image's drawn size, in frame pixels. */
  width: number;
  height: number;
  /** Its centre on the frame. */
  cx: number;
  cy: number;
  radians: number;
}

/** Where the reference overlay sits in a frame (or gate) of the given pixel size. */
export function overlayGeometry(
  width: number,
  height: number,
  r: Pick<PerspectiveReference, "scale" | "offsetPercent" | "rotationDegrees">,
  image: ImageSize,
): OverlayGeometry {
  const factor = Math.min(width / image.width, height / image.height) * r.scale;
  return {
    width: image.width * factor,
    height: image.height * factor,
    cx: width * (0.5 + r.offsetPercent[0] / 100),
    cy: height * (0.5 + r.offsetPercent[1] / 100),
    radians: (r.rotationDegrees * Math.PI) / 180,
  };
}

/** An image pixel position (origin top-left, v down) to frame pixels. */
export function imageToFrame(g: OverlayGeometry, image: ImageSize, p: Point): Point {
  const k = g.width / image.width;
  const u = (p[0] - image.width / 2) * k;
  const v = (p[1] - image.height / 2) * k;
  const c = Math.cos(g.radians);
  const s = Math.sin(g.radians);
  return [g.cx + u * c - v * s, g.cy + u * s + v * c];
}

/** A frame pixel position to the image's pixels. */
export function frameToImage(g: OverlayGeometry, image: ImageSize, p: Point): Point {
  const k = image.width / g.width;
  const dx = p[0] - g.cx;
  const dy = p[1] - g.cy;
  const c = Math.cos(g.radians);
  const s = Math.sin(g.radians);
  return [(dx * c + dy * s) * k + image.width / 2, (-dx * s + dy * c) * k + image.height / 2];
}
