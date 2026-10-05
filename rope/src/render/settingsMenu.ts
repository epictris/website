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
//
// Each setting is a radio group, as the platform's own radios behave: Tab moves
// between the groups (only the chosen option of each is in the tab order), and
// the arrows move the choice within the group that has the focus.

import {
  DEPTH_OF_FIELD_LEVELS,
  availableResolutions,
  depthOfFieldLabel,
  readSettings,
  resolutionLabel,
  writeSettings,
  type Resolution,
  type Settings,
} from "./settings";

export interface SettingsMenuHost {
  // A setting has changed: draw the frame with it.
  apply(settings: Settings): void;
  // The size the frame is actually drawn at now, which is the chosen
  // resolution or less - a window smaller than the setting draws at its own size
  // (see `fitCanvas`), and the panel says so rather than claiming pixels nobody
  // is drawing.
  drawnSize(): Resolution;
  opened(): void;
  closed(): void;
}

// One setting's row of options.
interface Group<T> {
  list: HTMLElement | null;
  options(): readonly T[];
  label(option: T): string;
  isChosen(option: T, settings: Settings): boolean;
  with(option: T, settings: Settings): Settings;
}

export class SettingsMenu {
  private readonly root: HTMLElement | null;
  private readonly note: HTMLElement | null;
  private readonly groups: Group<unknown>[];
  private settings: Settings = readSettings();
  private open = false;

  constructor(private readonly host: SettingsMenuHost) {
    this.root = document.getElementById("settings");
    this.note = document.getElementById("settings-note");
    const resolution: Group<Resolution> = {
      list: document.getElementById("settings-resolutions"),
      options: availableResolutions,
      label: resolutionLabel,
      isChosen: (r, s) => s.resolution.width === r.width && s.resolution.height === r.height,
      with: (r, s) => ({ ...s, resolution: r }),
    };
    const depthOfField: Group<(typeof DEPTH_OF_FIELD_LEVELS)[number]> = {
      list: document.getElementById("settings-dof"),
      options: () => DEPTH_OF_FIELD_LEVELS,
      label: depthOfFieldLabel,
      isChosen: (level, s) => s.depthOfField === level,
      with: (level, s) => ({ ...s, depthOfField: level }),
    };
    this.groups = [resolution, depthOfField] as Group<unknown>[];
    // Capture, so a focused option does not swallow the keys that close it.
    document.addEventListener("keydown", (e) => this.onKey(e), true);
  }

  // The frame has been refitted: a resize changes what is actually drawn under
  // the same setting. Called by the page AFTER the fit rather than from a resize
  // listener of its own, which would race the fit and read the old size.
  refresh(): void {
    if (this.open) this.paintNote();
  }

  // What the page should draw with, from the first frame.
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
    if (this.open || !this.root) return;
    this.open = true;
    this.paint();
    this.root.removeAttribute("hidden");
    this.chosenButton(this.groups[0]!)?.focus();
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

  private choose(group: Group<unknown>, option: unknown): void {
    this.settings = group.with(option, this.settings);
    writeSettings(this.settings);
    this.host.apply(this.settings);
    this.paint();
    this.chosenButton(group)?.focus();
  }

  private chosenButton(group: Group<unknown>): HTMLButtonElement | null {
    return group.list?.querySelector<HTMLButtonElement>('button[aria-checked="true"]') ?? null;
  }

  private paint(): void {
    for (const group of this.groups) {
      const list = group.list;
      if (!list) continue;
      list.innerHTML = "";
      for (const option of group.options()) {
        const chosen = group.isChosen(option, this.settings);
        const b = document.createElement("button");
        b.type = "button";
        b.className = "settings-option";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", chosen ? "true" : "false");
        b.tabIndex = chosen ? 0 : -1;
        b.textContent = group.label(option);
        b.addEventListener("click", () => this.choose(group, option));
        list.appendChild(b);
      }
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
    // The group holding the focus; the first if the focus is on none (the
    // panel was clicked on its background).
    const focused = document.activeElement;
    const group = this.groups.find((g) => g.list?.contains(focused)) ?? this.groups[0]!;
    const options = group.options();
    const at = options.findIndex((o) => group.isChosen(o, this.settings));
    const next = options[Math.max(0, Math.min(options.length - 1, (at < 0 ? 0 : at) + step))];
    if (next !== undefined && !group.isChosen(next, this.settings)) this.choose(group, next);
  }
}
