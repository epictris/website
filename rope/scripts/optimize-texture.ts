// One raw texture map in, one shippable WebP out.
//
//   bun run assets:optimize-texture ~/Downloads/stone_basecolor.png \
//     public/textures/quarry-stone-base.webp --map base
//
// The prop pipeline's argument, one asset type over (see optimize-asset.ts): the
// settings ARE the decision, and a map that arrives as a 12 MB 4k PNG because it
// was converted on a different day is a cost nothing downstream reports.
//
// Two settings carry the whole file, and they differ per MAP because the maps
// are not the same kind of image:
//
//   --map base                 an albedo is a picture, and lossy WebP at q90 is
//                              indistinguishable from the source at this size.
//   --map normal|roughness|metallic|ao
//                              these are DATA. A normal map's channels are a
//                              vector and a roughness map's grey is a number, so
//                              a lossy codec's ringing around an edge is not a
//                              softer picture, it is a surface that shades
//                              wrongly - visible as shimmering highlights along
//                              every crack. Encoded LOSSLESS *if the source is*.
//
//                              If the source is already a JPEG - which is what
//                              several texture libraries ship their data maps as
//                              - then the ringing is already in the pixels, and
//                              encoding it losslessly spends bytes preserving
//                              artifacts rather than preventing them. Poliigon's
//                              roughness map came out 16% LARGER than the JPEG it
//                              was made from that way. So a lossy source takes a
//                              high-quality lossy encode (q95) instead, which is
//                              a smaller file that is no further from the truth.
//
//   --lossless / --lossy       force either, for a source whose extension lies
//                              about what has been done to it.
//
//   --size 1024 (default)      the art style's own ceiling, the same one the
//                              prop pipeline puts on a glTF's textures. 2k maps
//                              on a wall seen at this camera distance are bytes
//                              nobody sees.
//
// ImageMagick rather than a Node image library, because it is what this repo
// already asks for when it converts an SVG snapshot to a PNG (see the debugging
// loop in CLAUDE.md), it is on any machine that authors assets, and adding a
// native image dependency to a project whose only binary is its props would cost
// more than it saves.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MAP_SLOTS = ["base", "normal", "roughness", "metallic", "ao"] as const;
type MapSlot = (typeof MAP_SLOTS)[number];

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const [input, output] = positional;
const slot = (flag("map") ?? "base") as MapSlot;
const size = Number(flag("size") ?? 1024);

if (!input || !output || !MAP_SLOTS.includes(slot) || !Number.isFinite(size)) {
  console.error(
    `usage: bun run assets:optimize-texture <input> <public/textures/out.webp> ` +
      `[--map ${MAP_SLOTS.join("|")}] [--size 1024]`,
  );
  process.exit(2);
}
if (!existsSync(input)) {
  console.error(`no such file: ${input}`);
  process.exit(2);
}
if (spawnSync("which", ["magick"]).status !== 0) {
  console.error("ImageMagick (`magick`) is required; install it and re-run.");
  process.exit(2);
}
// `public/textures/` is build output and gitignored, so on a fresh clone it does
// not exist until something writes into it - and the first thing that does is
// this, on the machine adding the asset.
mkdirSync(dirname(resolve(output)), { recursive: true });

// The albedo is the one map that is COLOUR and is treated as such. A data map is
// a grid of numbers that happens to be stored in an image, so it is
// REINTERPRETED rather than converted: `-set colorspace` changes the tag without
// touching a pixel, which means the resize averages the stored numbers and the
// encoder applies no transfer function to them. A roughness of 0.5 stays 0.5,
// which is what `NoColorSpace` on the three.js side then reads back.
//
// Converting instead - sRGB to linear, resize, back - is what this used to do,
// and it is wrong in both directions. On a linear EXR (which is how Poly Haven
// ships roughness and normals) it applies a transfer function the file never had;
// even where it round-trips, the resample happens in a different space and the
// mean drifts (measured: 0.2735 in the source, 0.2778 converted, 0.2735
// reinterpreted). A shifted roughness map is a surface that is uniformly shinier
// or duller than it was authored, which reads as a lighting bug rather than as a
// conversion one.
const colour = slot === "base";
// Lossless is worth paying for only where there is something to preserve: see
// the note above. An albedo is never encoded lossless - it is a picture.
// EXR, PNG and TIFF are lossless sources; JPEG is not (see above).
const lossySource = /\.jpe?g$/i.test(input);
const lossless =
  !args.includes("--lossy") && !colour && (args.includes("--lossless") || !lossySource);
const r = spawnSync(
  "magick",
  [
    resolve(input),
    ...(colour ? [] : ["-set", "colorspace", "sRGB", "-alpha", "off"]),
    "-resize",
    // `>` shrinks only: a 512 map authored small is not upscaled into bytes
    // that carry no more detail than it had.
    `${size}x${size}>`,
    ...(lossless ? ["-define", "webp:lossless=true"] : ["-quality", colour ? "90" : "95"]),
    "-strip",
    resolve(output),
  ],
  { stdio: "inherit" },
);
if (r.status !== 0) process.exit(r.status ?? 1);

const before = statSync(input).size;
const after = statSync(output).size;
const kb = (b: number) => `${(b / 1024).toFixed(0)} KB`;
console.log(
  `[assets] ${slot}: ${kb(before)} -> ${kb(after)} (${((after / before) * 100).toFixed(0)}%)` +
    `  ${lossless ? "lossless" : `q${colour ? 90 : 95}`}  ${output}`,
);
console.log(`[assets] next: \`bun run assets:publish ${output}\` uploads it and prints its`);
console.log(`[assets] TEXTURE_ASSETS map entry, sha256 included.`);
