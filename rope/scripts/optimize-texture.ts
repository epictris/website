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
//   --map base|emissive        an albedo is a picture, and so is an emission map
//                              (which parts of this surface glow, and in what
//                              colour). Lossy WebP at q90 is indistinguishable
//                              from the source at this size, and both are sRGB.
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
//   --channel r|g|b (default r) which channel of a SCALAR map carries the data.
//                              Roughness, metallic and AO are one number per
//                              texel, and every library stores that number
//                              somewhere different: Poly Haven ships it in RED
//                              alone (G and B are zero), while three.js reads
//                              roughness from GREEN, metalness from BLUE and AO
//                              from RED. Handing three.js the file as it arrives
//                              therefore samples an empty channel and gets 0 -
//                              and a wall at roughness 0 is a mirror, which
//                              looks exactly like "the map is not applied"
//                              rather than like a channel mistake.
//                              So a scalar map is flattened to GREY here: the
//                              named channel is written to all three, which is
//                              correct for every slot at once and cannot be got
//                              wrong downstream.
//                              A NORMAL map is never flattened - its three
//                              channels are a vector, not three copies of one
//                              number.
//
//   --size 1024 (default)      the art style's own ceiling, the same one the
//                              prop pipeline puts on a glTF's textures. 2k maps
//                              on a wall seen at this camera distance are bytes
//                              nobody sees.
//
//   --paint <px>               PAINT the map: the photographic detail is
//                              flattened into brush-sized patches so the surface
//                              reads as a digital painting rather than a photo
//                              (see "Painted surfaces" in docs/asset-store.md).
//                              <px> is the brush, in OUTPUT pixels: the window
//                              of a mean shift (see `paintArgs`) that collapses
//                              every region of near-one-colour into exactly one
//                              colour, a PLATEAU, with the edge between two
//                              plateaus left exactly where it was. On the
//                              albedo that is flat planes of tone with crisp
//                              breaks and no grain; on the normal map it is
//                              FACETS - regions of one normal with a sharp turn
//                              between them - which is most of the look, since
//                              in a lit scene the facets are what a painter's
//                              flat planes of tone are; on roughness, metallic
//                              and AO it is a facet matte or glossy as one
//                              plane. 30 is the brush in use on rock and
//                              ground, 20 on the avatar's iron, 40 on a fibrous
//                              source (marble) that 30 leaves as dots.
//                              The bake happens AFTER the resize, at the output
//                              size, so the brush is a size on screen and not a
//                              fraction of whatever the source's resolution was.
//   --soften <sigma>           with --paint: a Gaussian blur of this sigma (in
//                              output pixels) BEFORE the flattening, for a map
//                              whose small detail must go rather than be kept
//                              flat. A mean shift never merges a small island
//                              whose colour is far from its surroundings,
//                              however wide the window: the avatar's rust
//                              flecks survived a brush of 50 exactly as they
//                              had a brush of 20. Blurred first, the flecks
//                              dissolve into the plate and the blooms - the
//                              rust a painter draws - are what is left to
//                              flatten. 12 is the rust; rock wants none, its
//                              detail being the facets the brush is there to
//                              keep.
//   --cavity <file> [--cavity-channel r|g|b]
//                              base only, with --paint: multiply the albedo by
//                              the CRACKS of this ambient-occlusion source - its
//                              deepest tenth pushed to black, the rest to white
//                              - so a rock face carries its fissures as the
//                              crisp dark lines a painter draws them as. The
//                              channel is the AO's, as for a scalar map.
//   --saturate <pct>           base only, with --paint: saturation, 100 = as
//                              shot. A photo texture is duller than a painting
//                              of the same thing; 125-140 is the usual range.
//   --tint <hex>@<pct>         base only, with --paint: pull the whole map
//                              <pct> of the way toward a colour, which is how a
//                              ground whose dirt reads orange once saturated is
//                              brought back to olive without touching its moss.
//
//                              All four are recorded on the map's manifest entry
//                              (`TextureMap.paint`) beside its sha256, for the
//                              reason a prop's `--simplify` is: a painted map and
//                              a map painted by hand are the same file, and
//                              without the record the raw cannot be optimised
//                              into the same asset again.
//
// ImageMagick rather than a Node image library, because it is what this repo
// already asks for when it converts an SVG snapshot to a PNG (see the debugging
// loop in docs/debugging-physics.md), it is on any machine that authors assets, and adding a
// native image dependency to a project whose only binary is its props would cost
// more than it saves.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MAP_SLOTS = ["base", "normal", "roughness", "metallic", "ao", "emissive"] as const;
type MapSlot = (typeof MAP_SLOTS)[number];

const args = process.argv.slice(2);
// Flags that take a value, so the value is not mistaken for a path.
const VALUED = ["map", "size", "channel", "paint", "soften", "cavity", "cavity-channel", "saturate", "tint"];
const positional = args.filter(
  (a, i) => !a.startsWith("--") && !(i > 0 && VALUED.includes(args[i - 1]!.slice(2))),
);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const [input, output] = positional;
const slot = (flag("map") ?? "base") as MapSlot;
const size = Number(flag("size") ?? 1024);
const brush = flag("paint") === undefined ? undefined : Number(flag("paint"));
const soften = flag("soften") === undefined ? undefined : Number(flag("soften"));
const cavity = flag("cavity");
const cavityChannel = (flag("cavity-channel") ?? "r").toUpperCase();
const saturate = flag("saturate") === undefined ? undefined : Number(flag("saturate"));
const tint = flag("tint");
const tintMatch = tint === undefined ? null : /^(#[0-9a-fA-F]{6})@(\d+(?:\.\d+)?)$/.exec(tint);

const usage = (): never => {
  console.error(
    `usage: bun run assets:optimize-texture <input> <public/textures/out.webp> ` +
      `[--map ${MAP_SLOTS.join("|")}] [--size 1024] [--channel r|g|b]\n` +
      `       [--paint <px> [--soften <sigma>] [--cavity <ao-file> [--cavity-channel r|g|b]] [--saturate <pct>] [--tint <#hex>@<pct>]]`,
  );
  process.exit(2);
};
if (!input || !output || !MAP_SLOTS.includes(slot) || !Number.isFinite(size)) usage();
if (brush !== undefined && !(Number.isFinite(brush) && brush >= 1)) usage();
if (soften !== undefined && !(Number.isFinite(soften) && soften > 0)) usage();
if (soften !== undefined && brush === undefined) {
  console.error("--soften applies with --paint only");
  process.exit(2);
}
if (saturate !== undefined && !Number.isFinite(saturate)) usage();
if (tint !== undefined && !tintMatch) usage();
if (!["R", "G", "B"].includes(cavityChannel)) usage();
// The albedo treatments mean nothing on a data map, and a brush is what they are
// treatments OF: asking for them without one, or on the wrong map, is a typo
// rather than a request.
const albedoOnly = cavity !== undefined || saturate !== undefined || tint !== undefined;
if (albedoOnly && (brush === undefined || slot !== "base")) {
  console.error("--cavity, --saturate and --tint apply to `--map base` with `--paint` only");
  process.exit(2);
}
if (cavity !== undefined && !existsSync(cavity)) {
  console.error(`no such file: ${cavity}`);
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
const colour = slot === "base" || slot === "emissive";
// One number per texel, as against the albedo's colour and the normal's vector.
const scalar = slot === "roughness" || slot === "metallic" || slot === "ao";
const channel = (flag("channel") ?? "r").toUpperCase();
if (scalar && !["R", "G", "B"].includes(channel)) {
  console.error("--channel must be r, g or b");
  process.exit(2);
}
// Lossless is worth paying for only where there is something to preserve: see
// the note above. An albedo is never encoded lossless - it is a picture.
// EXR, PNG and TIFF are lossless sources; JPEG is not (see above).
const lossySource = /\.jpe?g$/i.test(input);
const lossless =
  !args.includes("--lossy") && !colour && (args.includes("--lossless") || !lossySource);

// The paint stage, as ImageMagick operators applied at the output size.
//
// The flattening is a MEAN SHIFT (`-mean-shift WxH+tol%`): every pixel walks
// to the mean of the pixels within its window whose colour is within the
// tolerance of its own, and keeps walking until it stops moving - so a region
// of near-one-colour collapses to exactly one colour, a PLATEAU, and the edge
// between two plateaus stays exactly where it was. On an albedo that is flat
// planes of tone with crisp breaks; on a normal map it is FACETS - regions of
// one normal turning sharply into the next - which under the sun are the flat
// planes of tone a painter lays down, and are most of the look.
//
// It is not a Kuwahara, which is what this was first. A Kuwahara's patches are
// its own window - soft dabs the size of the radius wherever the picture is,
// regardless of the picture's structure - and run cheaply (over the map shrunk
// and grown back) its every edge is blurred too. That read as blotchy and flat
// in the game: the facets in the reference art are large and sharp-edged, and a
// dab is neither. The mean shift finds the picture's own regions, at whatever
// size they are, and draws their edges sharp.
//
// It runs on the map SHRUNK: its cost is the window area times the pixels
// times the iterations, and at full size a brush this big is minutes per map.
// The shrink is half size up to a brush of 30 and smaller beyond it, so the
// window the shift runs with never exceeds 15 pixels - and so that the shrink
// itself, a box average, removes the detail smaller than the brush. That
// second job matters: a mean shift never merges a small island whose colour is
// far from its surroundings, however wide its window, so a rust fleck survived
// a brush of 50 as it had a brush of 20, and the avatar's iron stayed a
// speckle of photographed rust on a painted ball. Averaged away first, the
// flecks are gone and the blooms - the rust a painter draws - are what is left
// to flatten. The result is grown back with a Catmull-Rom resize, which is
// sharp across a plateau edge where the default filter would soften it back
// into the blur the Kuwahara had. `%[sz]` carries the pre-shrink geometry
// through so the grow-back lands on exactly the pixels the shrink left,
// whatever the source's size was (it may be under `--size`).
function paintArgs(px: number): string[] {
  const scale = Math.min(0.5, 15 / px);
  const win = Math.max(3, Math.round(px * scale));
  const smooth = (tolerance: number): string[] => [
    "-set", "option:sz", "%wx%h",
    ...(soften === undefined ? [] : ["-blur", `0x${soften}`]),
    "-resize", `${(scale * 100).toFixed(4)}%`,
    "-mean-shift", `${win}x${win}+${tolerance}%`,
    "-filter", "Catrom", "-resize", "%[sz]!",
  ];
  switch (slot) {
    case "base":
    case "emissive": {
      // The tones pushed apart a little after flattening, so two facets that
      // were a shade apart in the photograph are a stroke apart in the paint.
      const out = [...smooth(10), "-sigmoidal-contrast", "2x50%"];
      if (saturate !== undefined) out.push("-modulate", `100,${saturate}`);
      if (tintMatch) out.push("-fill", tintMatch[1]!, "-colorize", `${tintMatch[2]}%`);
      if (cavity !== undefined) {
        // The AO's darkest tenth or so is the bottom of a crack; everything
        // above the knee is open face and must stay white, or the multiply
        // darkens the whole rock rather than drawing lines on it. The lines are
        // then smoothed at a small brush so they are painted strokes, not
        // photographed pores.
        out.push(
          "(", resolve(cavity),
          "-set", "colorspace", "sRGB", "-alpha", "off",
          "-channel", cavityChannel, "-separate", "+channel",
          "-resize", "%[sz]!",
          "-level", "20%,70%", "-gamma", "0.6",
          "-resize", "50%", "-kuwahara", "2", "-resize", "%[sz]!",
          ")",
          "-compose", "multiply", "-composite",
        );
      }
      return out;
    }
    case "normal":
      return smooth(10);
    case "ao":
    case "roughness":
    case "metallic":
      // Plateaus of sheen too, so a facet is matte or glossy as one plane
      // rather than a blur of both - the wash this was first is what made every
      // surface look wet.
      return smooth(10);
  }
}

const r = spawnSync(
  "magick",
  [
    resolve(input),
    ...(colour ? [] : ["-set", "colorspace", "sRGB", "-alpha", "off"]),
    // Extract the data channel into all three, so the file answers whichever
    // channel the renderer asks for.
    ...(scalar ? ["-channel", channel, "-separate", "+channel"] : []),
    "-resize",
    // `>` shrinks only: a 512 map authored small is not upscaled into bytes
    // that carry no more detail than it had.
    `${size}x${size}>`,
    ...(brush === undefined ? [] : paintArgs(brush)),
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
    `  ${lossless ? "lossless" : `q${colour ? 90 : 95}`}${scalar ? `  ${channel}->grey` : ""}  ${output}`,
);
if (brush !== undefined) {
  // The record the manifest entry wants, in the shape `TextureMap.paint` takes.
  const record = [
    `brush: ${brush}`,
    ...(soften !== undefined ? [`soften: ${soften}`] : []),
    ...(cavity !== undefined ? ["cavity: true"] : []),
    ...(saturate !== undefined ? [`saturate: ${saturate}`] : []),
    ...(tintMatch ? [`tint: "${tint}"`] : []),
  ];
  console.log(`[assets] painted; record it on the map's entry:  paint: { ${record.join(", ")} },`);
}
console.log(`[assets] next: \`bun run assets:publish ${output}\` uploads it and prints its`);
console.log(`[assets] TEXTURE_ASSETS map entry, sha256 included.`);
