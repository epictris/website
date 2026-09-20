// The identity of the source this build/dev server is serving, provided by the
// `tree-stamp` Vite plugin (see vite.config.ts and src/sim/treeStamp.ts).
// Stamped into exported replay bundles so a bundle self-reports the TREE that
// recorded it, not merely the last commit before the server started.
declare module "virtual:tree-stamp" {
  export const commit: string;
  export const dirty: boolean;
  export const srcHash: string;
}

// The hash of each FILE-BACKED LEVEL's own bytes, by registry id, provided by
// the `level-hashes` Vite plugin (see vite.config.ts and
// `levelFileHash` in src/sim/treeStamp.ts). A narrower stamp than `srcHash`:
// feedback about a level says which authored level it is about, and a rating is
// still about the same level after a renderer edit has moved the tree.
declare module "virtual:level-hashes" {
  export const levelHashes: Record<string, string>;
}

// The byte store, inlined into every page as a plain script ahead of the module
// graph so the level's download starts at first paint (see
// `src/render3d/store.ts` for why it is a global rather than an export, and
// `storeScript` in vite.config.ts for how it gets there).
interface Window {
  // The level being played, live (see `main.ts`). A debug handle in the same
  // idiom as `__perf` and `__replay`: a driving script reads it, and nothing in
  // the app does.
  readonly __level?: unknown;
  // FALSE on a page that is the level select rather than a level (see
  // `paintMenu` in src/render3d/store.ts). `index.html`'s module tag reads it
  // and imports `main.ts` only when there is something to play, so a bare `/`
  // never downloads three.js or the level graph to draw a list of six words.
  //
  // A global rather than an export for the reason the store itself is one: the
  // script that decides is deliberately outside the module graph, because it
  // has to have run before the graph exists.
  __ropePlay?: boolean;
  // Load the app INTO THIS PAGE, set by `index.html`'s module tag on the one
  // page that did not load it: the level select. Picking a level there calls it
  // rather than following the row's link, because fullscreen and the pointer
  // lock are granted to that press and neither survives a navigation (see
  // `startOnClick` in src/render3d/store.ts).
  __ropeBoot?: () => void;
  // Where the desktop pointer last was, in CLIENT pixels, noted by the inlined
  // store script from the moment the page parses (`watchPointer` in
  // src/render3d/store.ts). Read by `AimPointer` for where an UNLOCKED cursor is
  // born, which is the aim a run opens on windowed; unset on a page nobody has
  // touched. A global for the same reason the store is one: the script that can
  // see the press is outside the module graph.
  __ropePointer?: { x: number; y: number };
  __ropeStore?: {
    // The bytes of `url`, adopting the download the preloader already started
    // for it. `bytes` is the manifest's size for the file.
    claim(url: string, bytes: number): Promise<Blob>;
    // Mark a file decoded and ready to draw - the second half of its
    // contribution to the bar.
    ready(url: string): void;
    // How much has arrived and how much is expected, in the bar's units.
    progress(): { received: number; total: number };
    // Fill the loading bar and stop driving it. The store writes the bar
    // itself, because it is what is running while the bytes arrive.
    endBar(): void;
  };
}
