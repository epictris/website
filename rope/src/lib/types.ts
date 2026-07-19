// Shared enums ported from the C# sources. Numeric values are load-bearing:
// several callers use them as signed multipliers (e.g. (int)wrapDir).

export enum WrapDirection {
  Clockwise = 1,
  CounterClockwise = -1,
}

export enum GenerationDirection {
  Forward = 1,
  Reversed = -1,
}

export enum IntersectionStatus {
  Overlap = -1,
  Touching = 0,
  Separate = 1,
}

export enum SurfaceType {
  WALL,
  FLOOR,
  CEILING,
}

export enum SlideType {
  KEEP_VELOCITY,
  PROJECT_VELOCITY,
}
