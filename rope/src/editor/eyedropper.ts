// The colour picker's eyedropper: pick a colour off anything the editor shows -
// the 3D scene, the 2D overlay, a swatch or a panel.
//
// The browser's own (`EyeDropper`) is Chromium's on Windows, macOS and ChromeOS
// only; on Linux, where this editor is used, there is none. So it is the page's
// own, and samples what the page painted: the elements under the point, front
// to back, each canvas by its pixel and every other element by its background
// colour, composited until opaque. Text and borders are not seen, only fills.
//
// The 3D canvas keeps no drawing buffer between frames (`preserveDrawingBuffer`
// costs frame time; see `Scene3D`), so a pixel is read inside an animation frame
// that runs AFTER the editor's: its loop asks for the next frame from inside the
// current one, so a frame asked for later, from an event, runs after it, with
// the scene just drawn and not yet presented.

export interface Eyedropper {
  cancel(): void;
}

export interface EyedropperOptions {
  // Elements never sampled (the picker it was opened from): it covers them too.
  ignore: readonly Element[];
  onPick(hex: string): void;
  // After a pick or a cancel, once.
  onEnd(): void;
}

// The swatch beside the pointer: offset so it never hides the pixel being read.
const CHIP_OFFSET = 16;
const CHIP_MARGIN = 8;

// Clicks, presses and keys while picking are the eyedropper's; nothing under it
// (the editor's canvas, a panel) hears them.
const SWALLOWED = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "wheel"];

export function startEyedropper(opts: EyedropperOptions): Eyedropper {
  const cover = document.createElement("div");
  cover.className = "ed-dropper";
  const chip = document.createElement("div");
  chip.className = "ed-dropper-chip";
  const chipSwatch = document.createElement("span");
  chipSwatch.className = "ed-dropper-swatch";
  const chipText = document.createElement("span");
  chip.append(chipSwatch, chipText);
  chip.hidden = true;
  cover.appendChild(chip);
  document.body.appendChild(cover);
  const ignore = [...opts.ignore, cover];

  let at: { x: number; y: number } | null = null;
  let picking = false;
  let frame = 0;
  let ended = false;

  const end = (): void => {
    if (ended) return;
    ended = true;
    cancelAnimationFrame(frame);
    window.removeEventListener("keydown", onKey, true);
    cover.remove();
    opts.onEnd();
  };

  const read = (): void => {
    frame = 0;
    if (ended || !at) return;
    const hex = sampleAt(at.x, at.y, ignore);
    if (picking) {
      if (hex) opts.onPick(hex);
      end();
      return;
    }
    showChip(hex);
  };
  const readSoon = (): void => {
    if (!frame) frame = requestAnimationFrame(read);
  };

  const showChip = (hex: string | null): void => {
    chip.hidden = hex === null || at === null;
    if (hex === null || at === null) return;
    chipSwatch.style.background = hex;
    chipText.textContent = hex;
    const w = chip.offsetWidth;
    const h = chip.offsetHeight;
    let left = at.x + CHIP_OFFSET;
    let top = at.y + CHIP_OFFSET;
    if (left + w > window.innerWidth - CHIP_MARGIN) left = at.x - CHIP_OFFSET - w;
    if (top + h > window.innerHeight - CHIP_MARGIN) top = at.y - CHIP_OFFSET - h;
    chip.style.left = `${Math.max(CHIP_MARGIN, left)}px`;
    chip.style.top = `${Math.max(CHIP_MARGIN, top)}px`;
  };

  for (const type of SWALLOWED) {
    cover.addEventListener(type, (e) => {
      e.stopPropagation();
      e.preventDefault();
    });
  }
  cover.addEventListener("pointermove", (e) => {
    e.stopPropagation();
    at = { x: e.clientX, y: e.clientY };
    readSoon();
  });
  cover.addEventListener("pointerdown", (e) => {
    at = { x: e.clientX, y: e.clientY };
    // The right button cancels, as it ends a tool elsewhere in the editor.
    if (e.button === 2) {
      end();
      return;
    }
    if (e.button !== 0) return;
    picking = true;
    readSoon();
  });
  cover.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    // Ours: the editor's Escape clears the selection, and the picker's closes it.
    e.stopPropagation();
    e.preventDefault();
    end();
  };
  window.addEventListener("keydown", onKey, true);

  return { cancel: end };
}

// One pixel of any canvas, drawn into this to be read: the same call reads a 2D
// canvas and a WebGL one.
let probe: CanvasRenderingContext2D | null = null;
// While hit testing, every element counts, as it is painted: the 3D canvas and
// the panels' container take no pointer events, and are still what is seen.
let everything: HTMLStyleElement | null = null;

// The colour on screen at (x, y), CSS pixels, as `#rrggbb`; null where nothing
// the page painted is found.
function sampleAt(x: number, y: number, ignore: readonly Element[]): string | null {
  everything ??= Object.assign(document.createElement("style"), {
    textContent: "* { pointer-events: auto !important; }",
  });
  document.head.appendChild(everything);
  let stack: Element[];
  try {
    stack = document.elementsFromPoint(x, y);
  } finally {
    everything.remove();
  }
  // Front to back, premultiplied: `left` is how much of what is behind still shows.
  const rgb = [0, 0, 0];
  let left = 1;
  for (const el of stack) {
    if (ignore.some((i) => i.contains(el))) continue;
    const style = getComputedStyle(el);
    const px = el instanceof HTMLCanvasElement ? canvasPixel(el, x, y) : cssColor(style.backgroundColor);
    if (!px) continue;
    const a = px[3] * Number(style.opacity);
    if (a <= 0) continue;
    for (let i = 0; i < 3; i++) rgb[i]! += left * a * px[i]!;
    left *= 1 - a;
    if (left < 1 / 512) break;
  }
  if (left === 1) return null;
  // Whatever still shows through is the browser's own white.
  return `#${rgb.map((c) => Math.round(c + left * 255).toString(16).padStart(2, "0")).join("")}`;
}

// The canvas pixel under (x, y), straight RGB 0-255 with alpha 0-1.
function canvasPixel(c: HTMLCanvasElement, x: number, y: number): [number, number, number, number] | null {
  const r = c.getBoundingClientRect();
  if (r.width === 0 || r.height === 0 || c.width === 0 || c.height === 0) return null;
  const sx = Math.floor(((x - r.left) * c.width) / r.width);
  const sy = Math.floor(((y - r.top) * c.height) / r.height);
  if (sx < 0 || sy < 0 || sx >= c.width || sy >= c.height) return null;
  if (!probe) {
    const p = document.createElement("canvas");
    p.width = p.height = 1;
    probe = p.getContext("2d", { willReadFrequently: true })!;
  }
  probe.clearRect(0, 0, 1, 1);
  probe.drawImage(c, sx, sy, 1, 1, 0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
}

// A computed `background-color`, which the browser always reports as `rgb()` or
// `rgba()`; anything else is not read.
function cssColor(text: string): [number, number, number, number] | null {
  const m = /^rgba?\(([^)]*)\)$/.exec(text.trim());
  if (!m) return null;
  const n = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (n.length < 3 || n.some((v) => !Number.isFinite(v))) return null;
  return [n[0]!, n[1]!, n[2]!, n[3] ?? 1];
}
