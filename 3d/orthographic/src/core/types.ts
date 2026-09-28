// Types for the scene document (mirrors schema.json) and the editor's internal state.

export type Vec3 = [number, number, number];
export type Point = [number, number];
export type Ring = Point[];

export type ViewId = "front" | "top" | "side";
export type ReferenceView = ViewId | "perspective";
export type AxisName = "x" | "y" | "z";

export type Blend = "normal" | "difference" | "screen" | "multiply";
export type DisplayStyle = "solid" | "clay" | "wire" | "ghost";

// ---- Internal editor state -------------------------------------------------
// Outlines are stored normalised to the object's bounding box: a point p in a
// view with axes (a, b) sits at world (min[a] + p[0] * size[a], min[b] + p[1] * size[b]).
// That keeps the shared axes of the three views consistent by construction.

export interface SceneObject {
  id: string;
  name: string;
  kind: string;
  color: string;
  min: Vec3;
  size: Vec3;
  outlines: Record<ViewId, Ring>;
  visible: boolean;
  locked: boolean;
  reviewed: boolean;
  opacity: number;
  notes: string;
}

export interface OrthoReference {
  image: string;
  opacity: number;
  visible: boolean;
  /** Lower-left corner and size on the view plane, in the view's (horizontal, vertical) axes. */
  min: Point;
  size: Point;
}

export interface PerspectiveReference {
  image: string;
  opacity: number;
  visible: boolean;
  offsetPercent: Point;
  scale: number;
  rotationDegrees: number;
  blend: Blend;
}

export interface Camera {
  position: Vec3;
  target: Vec3;
  fov: number;
  roll: number;
  near: number;
  far: number;
  frame: [number, number];
  locked: boolean;
}

export interface Display {
  style: DisplayStyle;
  grid: boolean;
  labels: boolean;
  crosshair: boolean;
}

export interface EditorState {
  scene: { title: string; size: Vec3; metersPerUnit: number | null; notes: string };
  objects: SceneObject[];
  camera: Camera;
  references: {
    front: OrthoReference | null;
    top: OrthoReference | null;
    side: OrthoReference | null;
    perspective: PerspectiveReference | null;
  };
  display: Display;
  reconstruction: { resolution: number };
}

export interface ImageAsset {
  id: string;
  name: string;
  mimeType: ImageMime;
  width: number;
  height: number;
  /** Base64 file contents. */
  data: string;
}

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

// ---- Issues ----------------------------------------------------------------

export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  /** Stable machine-readable code, e.g. "ring-self-intersection". */
  code: string;
  /** JSON Pointer into the document the issue is about ("" for the whole document). */
  path: string;
  message: string;
  objectId?: string;
  view?: ViewId;
}

export interface Result<T = undefined> {
  ok: boolean;
  issues: Issue[];
  value?: T;
}

// ---- Document (see schema.json) -------------------------------------------

export interface DocVec3 {
  x: number;
  y: number;
  z: number;
}

export interface DocObject {
  id: string;
  name?: string;
  kind?: string;
  color?: string;
  outlines: Record<ViewId, Ring>;
  visible?: boolean;
  locked?: boolean;
  reviewed?: boolean;
  opacity?: number;
  notes?: string;
  derived?: unknown;
}

export interface DocCamera {
  position: DocVec3;
  target: DocVec3;
  verticalFovDegrees?: number;
  focalLengthMm35Equivalent?: number;
  rollDegrees?: number;
  near?: number;
  far?: number;
  frame?: { width: number; height: number };
  locked?: boolean;
  derived?: unknown;
}

export interface DocOrthoReference {
  image: string;
  opacity?: number;
  visible?: boolean;
  min: Record<string, number>;
  size: Record<string, number>;
}

export interface DocPerspectiveReference {
  image: string;
  opacity?: number;
  visible?: boolean;
  offsetPercent?: { x: number; y: number };
  scale?: number;
  rotationDegrees?: number;
  blend?: Blend;
}

export interface DocImage {
  name?: string;
  mimeType: ImageMime;
  width: number;
  height: number;
  data?: string;
}

export interface SceneDocument {
  $schema?: string;
  format: "orthographic-scene";
  version: 1;
  scene: { title?: string; size: DocVec3; metersPerUnit?: number | null; notes?: string };
  objects: DocObject[];
  camera?: DocCamera;
  references?: {
    front?: DocOrthoReference | null;
    top?: DocOrthoReference | null;
    side?: DocOrthoReference | null;
    perspective?: DocPerspectiveReference | null;
  };
  images?: Record<string, DocImage>;
  display?: Partial<Display>;
  reconstruction?: { resolution?: number };
  editor?: Record<string, unknown>;
  meshCache?: unknown[];
}
