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
// An object is a union of parts (a plain object has one). Each part's box is
// stored as fractions of the object's box, and its outlines normalised to its
// own box: a point p in a view with axes (a, b) sits at part-box
// (min[a] + p[0] * size[a], min[b] + p[1] * size[b]), and the part box within
// the object's the same way. That keeps the shared axes of the three views
// consistent by construction, and lets an object move and scale as one.

export interface Part {
  /** Optional name, unique within the object. */
  id?: string;
  /** The part's box as fractions of the object's box (0..1 on each axis). */
  min: Vec3;
  size: Vec3;
  outlines: Record<ViewId, Ring>;
}

/**
 * An object's silhouette as traced in the perspective reference image, in
 * that image's pixels (origin top-left, v down). `hidden` lists runs of
 * guessed edges: [a, b] covers the edges from vertex a forward to vertex b.
 */
export interface Trace {
  points: Point[];
  hidden: [number, number][];
}

export interface SceneObject {
  id: string;
  name: string;
  kind: string;
  color: string;
  min: Vec3;
  size: Vec3;
  /** At least one; their boxes together make the object's box. */
  parts: Part[];
  /** Scenes stored before traces existed have neither of these. */
  trace?: Trace | null;
  /** Objects this one stands in front of, where their traces overlap. */
  inFrontOf?: string[];
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
  /** Lens shift as fractions of the frame, x right and y up (scenes stored before it existed have none). */
  shift?: [number, number];
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
  /** Every length is in metres; scaleBasis records how that size was established ("" when not yet). */
  scene: { title: string; size: Vec3; scaleBasis: string; notes: string };
  objects: SceneObject[];
  camera: Camera;
  references: {
    front: OrthoReference | null;
    top: OrthoReference | null;
    side: OrthoReference | null;
    perspective: PerspectiveReference | null;
  };
  display: Display;
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

/** What is known about an image without its pixels. */
export type ImageInfo = Omit<ImageAsset, "data">;

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
  /** One solid; or parts, a union of solids. */
  outlines?: Record<ViewId, Ring>;
  parts?: { id?: string; outlines: Record<ViewId, Ring> }[];
  trace?: { points: Point[]; hidden?: [number, number][] };
  inFrontOf?: string[];
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
  shift?: { x: number; y: number };
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
  scene: { title?: string; size: DocVec3; scale?: { basis?: string }; notes?: string };
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
  editor?: Record<string, unknown>;
}
