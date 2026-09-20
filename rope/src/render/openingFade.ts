// THE FADE A LEVEL OPENS ON: the blank screen the recorded arrival comes up
// out of (see `SpawnData.arrival` and docs/ball-rolling.md#the-recorded-arrival).
//
// A level that opens on an arrival opens on a run the player did not make, and
// the fade is what says so without a caption: the screen the loading bar was on
// stays for a beat, and the cave comes up out of it with the ball already
// falling. Cut to instead, the first frame reads as the level having started -
// and the seven seconds that follow read as a game not listening to its
// controls.
//
// IT IS THE LOADING SCREEN'S OWN COLOUR, not black, and that is the whole
// trick: `index.html` paints #1f2430 from the first byte, the loading screen is
// that colour, the letterbox bars around the frame are that colour
// (`LETTERBOX_COLOR`), and so is this. The screen the bar was on is therefore
// still on screen when the bar goes, with nothing having flashed between them -
// the removal of one and the first drawn frame of the other land in the same
// compositor frame (see the end of `frame` in main.ts), and both are the same
// flat colour.
//
// Render-side by construction: it reads the sim's frame number and draws over
// the picture. Nothing here reaches the level, so a bundle recorded through an
// opening is the run that was played, and a replay of it fades in exactly as
// the play did.

import { LETTERBOX_COLOR, type ViewTransform } from "./viewport";

// How long the screen stays blank before the level begins to show, in sim
// frames. Long enough to read as a held beat rather than as a slow first frame,
// short enough that nobody wonders whether the page is stuck: at 60 Hz this is
// three tenths of a second.
export const FADE_HOLD_FRAMES = 18;
// ...and how long it then takes to come up. Nine tenths of a second, so the
// whole opening costs 1.2 s of a 7.2 s arrival - the ball is still falling when
// the fade starts and is already swinging by the time it is over, which is what
// makes the fade an opening rather than a title card.
export const FADE_FRAMES = 54;

// How opaque the cover is on a frame `at` sim frames into the run, where `at`
// may be fractional - it is the interpolated frame the display is drawing, so
// the fade runs at the display's rate rather than the sim's and does not step
// at 60 Hz on a 144 Hz monitor.
//
// Smoothstepped rather than linear: a linear alpha leaves the picture and
// stands still at both ends, and what the eye reads at the end of a fade is the
// last few percent. Eased, the level arrives instead of stopping.
export function openingFadeAlpha(at: number): number {
  const t = (at - FADE_HOLD_FRAMES) / FADE_FRAMES;
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return 1 - t * t * (3 - 2 * t);
}

// Draw it over everything already on the 2D canvas - which is over the 3D one
// beneath it, so one rectangle covers the whole picture.
//
// The frame only, not the canvas: outside it are the letterbox bars, which are
// this colour already.
export function drawOpeningFade(ctx: CanvasRenderingContext2D, view: ViewTransform, alpha: number): void {
  if (alpha <= 0) return;
  ctx.setTransform(view.scale, 0, 0, view.scale, view.originX, view.originY);
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.fillStyle = LETTERBOX_COLOR;
  ctx.fillRect(0, 0, view.width, view.height);
  ctx.restore();
}
