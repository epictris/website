// The app's side of the byte store (see `render3d/store.ts`, which does the
// fetching and the counting from an inline script that runs before any of this
// module graph has been downloaded).
//
// Everything here is glue: take the bytes the store has collected, put a local
// URL over them for a three.js loader, and take it away again afterwards.

// A page always has the store: it is inlined into every HTML entry by
// `storeScript` in vite.config.ts. The one host without it is bun - `cli assets`
// and the vite config itself reach the asset manifest, and so this module,
// through ordinary imports - and nothing there downloads anything.
function store(): NonNullable<typeof window.__ropeStore> {
  const it = typeof window === "undefined" ? undefined : window.__ropeStore;
  if (!it) throw new Error("the byte store is missing from this page (see render3d/store.ts)");
  return it;
}

// How much has arrived, for the stall watchdog that decides the wait is over
// (see `LoadingScreen.wait`). The bar itself is written by the store.
export function downloadProgress(): { received: number; total: number } {
  return store().progress();
}

// Fill the loading bar and stop driving it - the store owns the bar, for the
// reason it owns the fetching (see `LoadingScreen.finish`, its only caller).
export function endLoadingBar(): void {
  store().endBar();
}

// Get `url`'s bytes - adopting the preloader's download if there is one - and
// run `use` on a local URL over them. `bytes` is the manifest's size for the
// file, which is what the bar counts against (see `TextureMap.bytes`).
//
// The object URL is revoked as soon as the loader resolves. The decoded image
// lives on in the `<img>` the texture holds - revoking a blob URL only stops NEW
// loads from it - and the blob itself is then free, which matters when the sky
// alone is 1.6 MB of it.
export async function withDownload<T>(
  url: string,
  bytes: number,
  use: (href: string) => Promise<T>,
): Promise<T> {
  const blob = await store().claim(url, bytes);
  const href = URL.createObjectURL(blob);
  try {
    const decoded = await use(href);
    // Decoded, which is the half of this file's cost that is not the download
    // and - from localhost, where the bytes arrive in 97 ms - very nearly all of
    // it. The bar counts it (see `progressOf` in store.ts).
    store().ready(url);
    return decoded;
  } finally {
    URL.revokeObjectURL(href);
  }
}
