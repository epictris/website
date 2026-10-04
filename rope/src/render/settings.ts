// THE PLAYER'S SETTINGS: what this browser has chosen about how the game is
// drawn, kept between visits (see `settingsMenu.ts` for the panel that edits it).
//
// It holds one thing so far, the RENDER RESOLUTION - the most pixels the frame is
// drawn with (see `fitCanvas`). The frame is always 1920x1080 view pixels, so
// this changes how sharp the picture is and what it costs to fill, never how
// much of the world is on screen.
//
// EVERY ACCESS IS GUARDED, for the reasons `progress.ts` gives: `localStorage`
// throws in some privacy modes and comes back empty after site data is cleared,
// and the game has to start at the default with no storage at all.

import { VIEW_HEIGHT, VIEW_WIDTH } from "./viewport";

export interface Resolution {
  width: number;
  height: number;
}

export interface Settings {
  resolution: Resolution;
}

export const SETTINGS_KEY = "rope.settings";

// The frame's own size, which is what the zoom constants are tuned against.
export const DEFAULT_RESOLUTION: Resolution = { width: VIEW_WIDTH, height: VIEW_HEIGHT };

// The 16:9 sizes on offer. Only 16:9, because the frame is: any other shape
// would be letterboxed back to 16:9 inside itself and the extra pixels drawn as
// bars.
const RESOLUTIONS: readonly Resolution[] = [
  { width: 960, height: 540 },
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3200, height: 1800 },
  { width: 3840, height: 2160 },
];

// The sizes THIS display can show. Above the screen's own device pixels a
// resolution is fragments the compositor throws away on the way out, so those
// are left off - except the default, which is always on offer so the setting
// can be put back however small the screen is.
export function availableResolutions(): Resolution[] {
  const dpr = window.devicePixelRatio || 1;
  const screenWidth = Math.round(Math.max(window.screen.width, window.screen.height) * dpr);
  return RESOLUTIONS.filter(
    (r) => r.width <= screenWidth || r.width === DEFAULT_RESOLUTION.width,
  );
}

export function resolutionLabel(r: Resolution): string {
  return `${r.width}x${r.height}`;
}

function isOffered(r: Resolution): boolean {
  return RESOLUTIONS.some((o) => o.width === r.width && o.height === r.height);
}

export function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Settings>) : null;
    const r = parsed?.resolution;
    // A stored size that is no longer offered - a hand-edited entry, or one a
    // later version dropped - is the default rather than a size nobody chose.
    if (r && typeof r.width === "number" && typeof r.height === "number" && isOffered(r)) {
      return { resolution: { width: r.width, height: r.height } };
    }
  } catch {
    // Unreadable is the same as unset.
  }
  return { resolution: DEFAULT_RESOLUTION };
}

// Returns whether the write landed. The caller applies the setting either way:
// a choice that cannot be remembered still holds for this visit.
export function writeSettings(settings: Settings): boolean {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
