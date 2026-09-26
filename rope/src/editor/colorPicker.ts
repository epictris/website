// The editor's colour field: a swatch that opens a picker drawn in the page.
//
// It replaces `<input type="color">`, whose picker is the BROWSER's popup and
// is placed by the browser. Chromium keeps that popup on screen from where it
// believes its window sits, and under Wayland a client is never told where its
// window is, so the popup opened from a swatch in the inspector (the right edge
// of a maximised window) ran straight off the screen with most of it unreachable.
// Nothing the page can say moves a native popup, so the picker is the page's own
// and is kept inside the viewport by the same arithmetic that places it.
//
// It is deliberately small: saturation/value square, hue strip, hex field. The
// value in and out is `#rrggbb`, exactly what the native input spoke, so every
// call site kept its model code.

export interface ColorInput {
  // The swatch to put in the panel. Clicking it opens the picker.
  readonly el: HTMLButtonElement;
  // `#rrggbb`. Setting it while the picker is open updates the picker too.
  value: string;
  // Whether the picker is open: a readout refreshing the swatch from the model
  // leaves it alone while the author is dragging it, as it left a focused input.
  readonly editing: boolean;
}

// Only one picker is ever open; opening another closes the first.
let closeOpen: (() => void) | null = null;

// `onBegin` is called once per opening, before its first change: one undo step
// per editing session. `onInput` is called on every change, as `input` was.
export function colorInput(
  value: string,
  onBegin: () => void,
  onInput: (hex: string) => void,
): ColorInput {
  const swatch = document.createElement("button");
  swatch.type = "button";
  swatch.className = "ed-color";
  let current = normHex(value);
  swatch.style.background = current;

  let pop: Picker | null = null;

  const close = (): void => {
    if (!pop) return;
    pop.destroy();
    pop = null;
    if (closeOpen === close) closeOpen = null;
  };

  swatch.addEventListener("click", (e) => {
    e.preventDefault();
    if (pop) {
      close();
      return;
    }
    closeOpen?.();
    // The undo step is taken on the first change rather than on opening, so a
    // picker opened to look and closed again leaves no empty step behind.
    let began = false;
    pop = new Picker(swatch, current, (hex) => {
      if (!began) {
        onBegin();
        began = true;
      }
      current = hex;
      swatch.style.background = hex;
      onInput(hex);
    }, close);
    closeOpen = close;
  });

  return {
    el: swatch,
    get value() {
      return current;
    },
    set value(v: string) {
      current = normHex(v);
      swatch.style.background = current;
      pop?.show(current);
    },
    get editing() {
      return pop !== null;
    },
  };
}

// Pixels. The square is wide enough to place a colour to about a percent.
const SQUARE_W = 180;
const SQUARE_H = 120;
const HUE_H = 12;
// Clearance from the viewport's edges and from the swatch.
const MARGIN = 8;
const GAP = 4;

class Picker {
  private readonly root = document.createElement("div");
  private readonly square = document.createElement("div");
  private readonly squareDot = document.createElement("div");
  private readonly hue = document.createElement("div");
  private readonly hueDot = document.createElement("div");
  private readonly hex = document.createElement("input");
  // Held as HSV rather than re-derived from the hex, so dragging to black or to
  // grey does not lose the hue the author had picked.
  private h = 0;
  private s = 0;
  private v = 0;
  private frame = 0;
  private readonly onDown = (e: PointerEvent): void => {
    // The swatch's own row counts as inside: its label forwards a click to the
    // swatch, which toggles the picker, and closing here first would reopen it.
    const t = e.target as Node;
    const own = this.anchor.closest("label") ?? this.anchor;
    if (!this.root.contains(t) && !own.contains(t)) this.close();
  };
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    // Ours, not the editor's: Escape also clears the selection, and closing a
    // picker should not do that as well.
    e.stopPropagation();
    e.preventDefault();
    this.close();
  };

  constructor(
    private readonly anchor: HTMLElement,
    hex: string,
    private readonly emit: (hex: string) => void,
    private readonly close: () => void,
  ) {
    this.root.className = "ed-picker";
    this.square.className = "ed-picker-sv";
    this.square.style.width = `${SQUARE_W}px`;
    this.square.style.height = `${SQUARE_H}px`;
    this.squareDot.className = "ed-picker-dot";
    this.square.appendChild(this.squareDot);
    this.hue.className = "ed-picker-hue";
    this.hue.style.width = `${SQUARE_W}px`;
    this.hue.style.height = `${HUE_H}px`;
    this.hueDot.className = "ed-picker-bar";
    this.hue.appendChild(this.hueDot);
    this.hex.className = "ed-num ed-picker-hex";
    this.hex.spellcheck = false;
    this.root.append(this.square, this.hue, this.hex);

    this.drag(this.square, (x, y) => {
      this.s = x;
      this.v = 1 - y;
      this.changed();
    });
    this.drag(this.hue, (x) => {
      this.h = x * 360;
      this.changed();
    });
    this.hex.addEventListener("input", () => {
      const parsed = parseHex(this.hex.value);
      if (!parsed) return;
      [this.h, this.s, this.v] = rgbToHsv(parsed, this.h);
      this.paint();
      this.emit(normHex(this.hex.value));
    });
    this.hex.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.close();
    });

    this.show(hex);
    document.body.appendChild(this.root);
    window.addEventListener("pointerdown", this.onDown, true);
    window.addEventListener("keydown", this.onKey, true);
    // Placed every frame rather than once: the inspector scrolls and the window
    // resizes under an open picker, and a panel rebuilt under it takes the
    // swatch away, which is the picker's cue to go.
    const follow = (): void => {
      if (!this.anchor.isConnected) {
        this.close();
        return;
      }
      this.place();
      this.frame = requestAnimationFrame(follow);
    };
    follow();
  }

  show(hex: string): void {
    const rgb = parseHex(hex) ?? [0, 0, 0];
    [this.h, this.s, this.v] = rgbToHsv(rgb, this.h);
    this.hex.value = normHex(hex);
    this.paint();
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    window.removeEventListener("pointerdown", this.onDown, true);
    window.removeEventListener("keydown", this.onKey, true);
    this.root.remove();
  }

  private changed(): void {
    const hex = rgbToHex(hsvToRgb(this.h, this.s, this.v));
    this.hex.value = hex;
    this.paint();
    this.emit(hex);
  }

  private paint(): void {
    this.square.style.backgroundColor = `hsl(${this.h}, 100%, 50%)`;
    this.squareDot.style.left = `${this.s * SQUARE_W}px`;
    this.squareDot.style.top = `${(1 - this.v) * SQUARE_H}px`;
    this.squareDot.style.background = rgbToHex(hsvToRgb(this.h, this.s, this.v));
    this.hueDot.style.left = `${(this.h / 360) * SQUARE_W}px`;
  }

  // Below the swatch, right edges aligned, and flipped above it when there is no
  // room below; then clamped into the viewport whatever the swatch's position,
  // which is the whole reason this picker exists.
  private place(): void {
    const a = this.anchor.getBoundingClientRect();
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    let left = a.right - w;
    let top = a.bottom + GAP;
    if (top + h > window.innerHeight - MARGIN) top = a.top - GAP - h;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - MARGIN - w));
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - MARGIN - h));
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  // A press anywhere in `el` sets the value there and keeps setting it while
  // the pointer is held, inside the element or not.
  private drag(el: HTMLElement, set: (x: number, y: number) => void): void {
    const at = (e: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      set(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      at(e);
    });
    el.addEventListener("pointermove", (e) => {
      if (el.hasPointerCapture(e.pointerId)) at(e);
    });
  }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

// `#rgb` and `#rrggbb`, with or without the `#`. Anything else is not yet a
// colour (a hex half typed), and the field waits for more.
function parseHex(text: string): [number, number, number] | null {
  let t = text.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(t)) t = t.replace(/./g, "$&$&");
  if (!/^[0-9a-f]{6}$/i.test(t)) return null;
  const n = parseInt(t, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function normHex(text: string): string {
  return rgbToHex(parseHex(text) ?? [0, 0, 0]);
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

// `hue` is kept where the colour has none (a grey), so the strip stays put.
function rgbToHsv([r, g, b]: [number, number, number], hue: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = hue;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d + 6) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return [h, max === 0 ? 0 : d / max, max / 255];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}
