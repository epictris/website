// THE SETTINGS PANEL, toggled by S over a level (see `main.ts`).
//
// Markup in index.html rather than built here, like the completion panel, so the
// two share one idiom: the flat page, hairline borders, square corners, #65bddb
// only on the thing chosen.
//
// A choice APPLIES AS IT IS MADE and is remembered at once. There is no Apply
// and no Cancel: the level is right behind the panel, so the new resolution is
// its own preview, and a setting that only took effect on a second press would
// be a preview of nothing.

import {
  availableResolutions,
  readSettings,
  resolutionLabel,
  writeSettings,
  type Resolution,
  type Settings,
} from "./settings";

export interface SettingsMenuHost {
  // The setting has changed: redraw the frame at it.
  apply(settings: Settings): void;
  // The size the frame is actually drawn at now, which is the chosen
  // resolution or less - a window smaller than the setting draws at its own size
  // (see `fitCanvas`), and the panel says so rather than claiming pixels nobody
  // is drawing.
  drawnSize(): Resolution;
  opened(): void;
  closed(): void;
}

export class SettingsMenu {
  private readonly root: HTMLElement | null;
  private readonly list: HTMLElement | null;
  private readonly note: HTMLElement | null;
  private settings: Settings = readSettings();
  private open = false;

  constructor(private readonly host: SettingsMenuHost) {
    this.root = document.getElementById("settings");
    this.list = document.getElementById("settings-resolutions");
    this.note = document.getElementById("settings-note");
    // Capture, so a focused option does not swallow the keys that close it.
    document.addEventListener("keydown", (e) => this.onKey(e), true);
  }

  // The frame has been refitted: a resize changes what is actually drawn under
  // the same setting. Called by the page AFTER the fit rather than from a resize
  // listener of its own, which would race the fit and read the old size.
  refresh(): void {
    if (this.open) this.paintNote();
  }

  // What the page should draw at, from the first frame.
  get current(): Settings {
    return this.settings;
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    // A page whose markup has no panel (`shot.html`) has nothing to show.
    if (this.open || !this.root || !this.list) return;
    this.open = true;
    this.paintList();
    this.root.removeAttribute("hidden");
    this.selectedButton()?.focus();
    this.host.opened();
  }

  close(): void {
    if (!this.open || !this.root) return;
    this.open = false;
    this.root.setAttribute("hidden", "");
    // The focus would otherwise stay on a hidden button, and the next Space
    // pressed in the level would click it.
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.host.closed();
  }

  private choose(r: Resolution): void {
    this.settings = { ...this.settings, resolution: r };
    writeSettings(this.settings);
    this.host.apply(this.settings);
    this.paintList();
    this.selectedButton()?.focus();
  }

  private isChosen(r: Resolution): boolean {
    const c = this.settings.resolution;
    return c.width === r.width && c.height === r.height;
  }

  private selectedButton(): HTMLButtonElement | null {
    return this.list?.querySelector<HTMLButtonElement>('button[aria-checked="true"]') ?? null;
  }

  private paintList(): void {
    if (!this.list) return;
    this.list.innerHTML = "";
    for (const r of availableResolutions()) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "settings-option";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", this.isChosen(r) ? "true" : "false");
      b.tabIndex = this.isChosen(r) ? 0 : -1;
      b.textContent = resolutionLabel(r);
      b.addEventListener("click", () => this.choose(r));
      this.list.appendChild(b);
    }
    this.paintNote();
  }

  private paintNote(): void {
    if (!this.note) return;
    const drawn = this.host.drawnSize();
    const chosen = this.settings.resolution;
    this.note.textContent =
      drawn.width < chosen.width
        ? `Drawing ${resolutionLabel(drawn)}: the window is smaller than ${resolutionLabel(chosen)}.`
        : "";
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.open) return;
    if (e.code === "Escape" || e.code === "KeyS") {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) this.close();
      return;
    }
    // Arrows move the choice, the way a radio group does.
    const step = e.code === "ArrowDown" || e.code === "ArrowRight"
      ? 1
      : e.code === "ArrowUp" || e.code === "ArrowLeft"
        ? -1
        : 0;
    if (step === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const options = availableResolutions();
    const at = options.findIndex((r) => this.isChosen(r));
    const next = options[Math.max(0, Math.min(options.length - 1, (at < 0 ? 0 : at) + step))];
    if (next && !this.isChosen(next)) this.choose(next);
  }
}
