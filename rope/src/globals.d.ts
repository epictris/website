// The identity of the source this build/dev server is serving, provided by the
// `tree-stamp` Vite plugin (see vite.config.ts and src/sim/treeStamp.ts).
// Stamped into exported replay bundles so a bundle self-reports the TREE that
// recorded it, not merely the last commit before the server started.
declare module "virtual:tree-stamp" {
  export const commit: string;
  export const dirty: boolean;
  export const srcHash: string;
}

// The byte store, inlined into every page as a plain script ahead of the module
// graph so the level's download starts at first paint (see
// `src/render3d/store.ts` for why it is a global rather than an export, and
// `storeScript` in vite.config.ts for how it gets there).
interface Window {
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
