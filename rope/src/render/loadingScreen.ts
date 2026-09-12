// The loading screen: the flat #1f2430 page with a white bar on it that covers
// the wait between opening the URL and having something to play.
//
// ALMOST NONE OF IT IS HERE, and that is the design. By the time this module is
// running, the wait it covers is most of the way through: the markup is in
// `index.html` so the screen is on the first frame the browser paints, and the
// bar is filled by `render3d/store.ts`, an inline script that has been
// downloading the level - and counting the bytes - since before this module was
// asked for. A bar drawn by the app cannot move until the app has finished
// downloading, which is exactly the part of the wait a bar is for.
//
// What is left here is the screen's LIFE: how long to wait, and taking it off.
//
// It is also the whole of the gate: `main.ts` does not start its frame loop
// until the wait is over, so the level is not stepping - and the player is not
// falling - behind a screen nobody can see through. That is the one place the
// game deliberately WAITS for assets; everywhere else a late asset is the
// design (see `assetsSettled`).

import { assetsSettled, pendingAssets } from "../render3d/assets";
import { downloadProgress, endLoadingBar } from "../render3d/download";

// How long the gate will hold with NOTHING ARRIVING before it plays anyway.
// Nothing in the store is required to draw a level - a missing texture is a
// generated surface and a missing prop is a placeholder box - so a load that
// never lands must cost a slow start and not the session.
//
// A stall rather than a wall clock, because a wall clock cannot tell a hung
// fetch from a slow one and this level is 26 MB: the 30 s ceiling this replaces
// was less than the honest download time on anything under 8 Mbit, so a player
// on a real connection had the screen taken away mid-download and was handed a
// level still wearing half its fallback surfaces. Progress is progress however
// slow it is; what must not be waited on is a connection that has stopped.
const STALL_MS = 15_000;
// How often that is checked. Coarse on purpose - it is a watchdog, and the
// thing it watches moves in kilobytes.
const STALL_POLL_MS = 500;

export class LoadingScreen {
  private readonly root = document.getElementById("loading");

  // Wait for the assets, but never for ever. Giving up is reported with the
  // names of what was still outstanding, because "the game started with
  // placeholder rocks" needs to be traceable to the load that did not land.
  async wait(): Promise<void> {
    let timer = 0;
    const stalled = new Promise<"stalled">((resolve) => {
      let last = -1;
      let since = performance.now();
      timer = window.setInterval(() => {
        const { received } = downloadProgress();
        if (received !== last) {
          last = received;
          since = performance.now();
          return;
        }
        if (performance.now() - since >= STALL_MS) resolve("stalled");
      }, STALL_POLL_MS);
    });
    const outcome = await Promise.race([assetsSettled().then(() => "settled" as const), stalled]);
    clearInterval(timer);
    if (outcome === "stalled") {
      console.warn(
        `[loading] nothing arrived for ${STALL_MS / 1000}s; still waiting on:`,
        pendingAssets().join(", ") || "(nothing named)",
      );
    }
  }

  // Take the screen off the page, with nothing in between. Called from INSIDE
  // the frame callback that has just drawn the level (see `boot`), so the
  // removal and that drawing are composited together: the last thing on screen
  // is the full bar and the next is the game. A fade would only be a quarter of
  // a second of neither, after the wait it exists to cover is already over.
  finish(): void {
    endLoadingBar();
    this.root?.remove();
  }
}
