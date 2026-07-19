// Immutable 2D vector matching Godot's Vector2 semantics (the subset the game uses).
// Godot uses y-down screen space. Value semantics: every operation returns a new Vec2,
// so there is no aliasing — this mirrors C# struct copy-on-assignment exactly.

export class Vec2 {
  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static readonly ZERO = new Vec2(0, 0);
  static readonly ONE = new Vec2(1, 1);
  static readonly UP = new Vec2(0, -1);
  static readonly DOWN = new Vec2(0, 1);
  static readonly LEFT = new Vec2(-1, 0);
  static readonly RIGHT = new Vec2(1, 0);

  static of(x: number, y: number): Vec2 {
    return new Vec2(x, y);
  }

  add(o: Vec2): Vec2 {
    return new Vec2(this.x + o.x, this.y + o.y);
  }

  sub(o: Vec2): Vec2 {
    return new Vec2(this.x - o.x, this.y - o.y);
  }

  mul(s: number): Vec2 {
    return new Vec2(this.x * s, this.y * s);
  }

  div(s: number): Vec2 {
    return new Vec2(this.x / s, this.y / s);
  }

  neg(): Vec2 {
    return new Vec2(-this.x, -this.y);
  }

  withX(x: number): Vec2 {
    return new Vec2(x, this.y);
  }

  withY(y: number): Vec2 {
    return new Vec2(this.x, y);
  }

  dot(o: Vec2): number {
    return this.x * o.x + this.y * o.y;
  }

  // Godot Vector2.Cross: x*o.y - y*o.x (returns a scalar in 2D).
  cross(o: Vec2): number {
    return this.x * o.y - this.y * o.x;
  }

  lengthSquared(): number {
    return this.x * this.x + this.y * this.y;
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  normalized(): Vec2 {
    const l = this.length();
    return l === 0 ? Vec2.ZERO : new Vec2(this.x / l, this.y / l);
  }

  distanceTo(o: Vec2): number {
    const dx = o.x - this.x;
    const dy = o.y - this.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  distanceSquaredTo(o: Vec2): number {
    const dx = o.x - this.x;
    const dy = o.y - this.y;
    return dx * dx + dy * dy;
  }

  directionTo(o: Vec2): Vec2 {
    return o.sub(this).normalized();
  }

  angle(): number {
    return Math.atan2(this.y, this.x);
  }

  // Signed angle from this to `to`, matching Godot's Vector2.AngleTo.
  angleTo(to: Vec2): number {
    return Math.atan2(this.cross(to), this.dot(to));
  }

  rotated(rad: number): Vec2 {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return new Vec2(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  // Godot Vector2.Orthogonal: (y, -x).
  orthogonal(): Vec2 {
    return new Vec2(this.y, -this.x);
  }

  // Godot Vector2.Slide: this - normal * this.Dot(normal). Assumes `normal` is unit length.
  slide(normal: Vec2): Vec2 {
    return this.sub(normal.mul(this.dot(normal)));
  }

  // Godot Vector2.Slerp: spherical interpolation between two vectors.
  slerp(to: Vec2, weight: number): Vec2 {
    const startLenSq = this.lengthSquared();
    const endLenSq = to.lengthSquared();
    if (startLenSq === 0 || endLenSq === 0) {
      return this.lerp(to, weight);
    }
    const startLen = Math.sqrt(startLenSq);
    const resultLen = lerpF(startLen, Math.sqrt(endLenSq), weight);
    const angle = this.angleTo(to);
    return this.rotated(angle * weight).mul(resultLen / startLen);
  }

  lerp(to: Vec2, weight: number): Vec2 {
    return new Vec2(lerpF(this.x, to.x, weight), lerpF(this.y, to.y, weight));
  }

  isFinite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y);
  }

  equals(o: Vec2): boolean {
    return this.x === o.x && this.y === o.y;
  }

  clone(): Vec2 {
    return new Vec2(this.x, this.y);
  }

  toString(): string {
    return `(${this.x}, ${this.y})`;
  }
}

function lerpF(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
