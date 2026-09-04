// The identity of the source this build/dev server is serving, provided by the
// `tree-stamp` Vite plugin (see vite.config.ts and src/sim/treeStamp.ts).
// Stamped into exported replay bundles so a bundle self-reports the TREE that
// recorded it, not merely the last commit before the server started.
declare module "virtual:tree-stamp" {
  export const commit: string;
  export const dirty: boolean;
  export const srcHash: string;
}
