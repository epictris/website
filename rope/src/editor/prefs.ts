// WHAT THIS BROWSER REMEMBERS OF THE EDITOR: the toolbar's view toggles (snap,
// edge clamp, all debug, reflections, shadows, water, roots and scene) and the level
// last open. They are how the author likes to work rather than anything about
// a level, so they are kept in `localStorage` and never written into a file.
//
// Every access is guarded: `localStorage` throws in some privacy modes and is
// empty after site data is cleared, and the editor must open with the defaults
// then. A stored toggle of the wrong type is ignored field by field, so a
// toggle added later starts at its default rather than voiding the rest.

export interface EditorViewSettings {
  snap: boolean;
  edgeClamp: boolean;
  allDebug: boolean;
  reflections: boolean;
  shadows: boolean;
  water: boolean;
  roots: boolean;
  scene: boolean;
}

export const VIEW_SETTINGS_KEY = "rope.editor.view";

const DEFAULTS: EditorViewSettings = {
  snap: true,
  edgeClamp: true,
  allDebug: false,
  reflections: true,
  shadows: true,
  water: true,
  roots: true,
  scene: true,
};

export function readViewSettings(): EditorViewSettings {
  const settings = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(VIEW_SETTINGS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null) return settings;
    const stored = parsed as Record<string, unknown>;
    for (const key of Object.keys(DEFAULTS) as (keyof EditorViewSettings)[]) {
      const v = stored[key];
      if (typeof v === "boolean") settings[key] = v;
    }
  } catch {
    // Unreadable storage: the defaults.
  }
  return settings;
}

// Write one toggle back. Losing a write is tolerable: the next session opens
// with the toggle as it was before.
export function writeViewSetting<K extends keyof EditorViewSettings>(key: K, value: boolean): void {
  try {
    const settings = readViewSettings();
    settings[key] = value;
    localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Unwritable storage: remembered for this session only.
  }
}

// The widths `+ Root` draws a new root at, in metres: its start (base) and its
// tip. How the author likes to draw rather than anything about a level, so
// remembered here like the view toggles. Null for a width never set, which the
// caller fills with its own default; a stored value that is not a positive
// number is ignored.
export const ROOT_WIDTHS_KEY = "rope.editor.rootWidths";

export interface RootWidths {
  start: number | null;
  tip: number | null;
}

export function readRootWidths(): RootWidths {
  const out: RootWidths = { start: null, tip: null };
  try {
    const raw = localStorage.getItem(ROOT_WIDTHS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null) return out;
    const stored = parsed as Record<string, unknown>;
    for (const key of ["start", "tip"] as const) {
      const v = stored[key];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = v;
    }
  } catch {
    // Unreadable storage: the caller's defaults.
  }
  return out;
}

export function writeRootWidths(widths: { start: number; tip: number }): void {
  try {
    localStorage.setItem(ROOT_WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    // Unwritable storage: remembered for this session only.
  }
}

// The level the editor last had open, by its name on disk, which a fresh
// editor reopens. Null is the unnamed model (New, or the file deleted), and
// opens the editor empty.
export const LAST_LEVEL_KEY = "rope.editor.level";

export function readLastLevel(): string | null {
  try {
    return localStorage.getItem(LAST_LEVEL_KEY);
  } catch {
    return null;
  }
}

export function writeLastLevel(name: string | null): void {
  try {
    if (name === null) localStorage.removeItem(LAST_LEVEL_KEY);
    else localStorage.setItem(LAST_LEVEL_KEY, name);
  } catch {
    // Unwritable storage: the next editor opens empty.
  }
}
