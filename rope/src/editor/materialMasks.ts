// MATERIAL LAYERS LIVE in the editor (docs/formations.md "Material layers"):
// what lets the Texturing workspace's brush show the material itself as it
// paints, before anything is built for the game.
//
// - The library (`/api/materials`): the materials and each file's sha256,
//   read again every few seconds while the Texturing workspace is open, so a
//   material saved in Blender is a new library, and a new bake, at once.
// - Each material is baked onto each rock it is painted on (a `material` job,
//   scripts/material-layer-build.ts), asked for the first time it is drawn
//   there; until it lands the coverage dots show the paint.
// - Each patch's MASK is computed here from its strokes, by the code the build
//   writes `mask.png` with (formation/materialMask.ts), over the rock's
//   iteration mesh (`geometry.glb`, whichever look is drawn, as the build
//   reads it), into a texture updated in place as strokes are added: a dab
//   costs its own stamp and one upload, and no rebuild of the scene.
//
// It hands the scene what to draw for each material layer
// (`render3d/materialLayers.ts`); what was built is drawn until its own is
// ready.

import * as THREE from "three";
import { decorationMaskFile, isMaterialLayer, materialOf } from "../formation/decoration";
import { MaterialMask, MASK_SIDE, rasterizePaintUv, type MaskTexels, type PaintUvMesh } from "../formation/materialMask";
import { materialLayerHash, MATERIALS_API, type MaterialLibraryEntry } from "../formation/materialLayer";
import { FORMATION_STORE, GEOMETRY_FILE } from "../formation/store";
import type { DecorationObjectData } from "../level/levelFormat";
import { loadFormationFile } from "../render3d/formations";
import type { MaterialLayerDraw } from "../render3d/materialLayers";
import { paintLayerTexture } from "../render3d/paintLayers";
import { showToast } from "../render/toast";
import type { FormationJobs, JobState } from "./formationJobs";
import type { EdItem, EdModel } from "./model";

// How often the library is read again while it is watched, ms.
const LIBRARY_POLL_MS = 3000;

interface Live {
  host: string;
  mask: MaterialMask;
  data: Uint8Array;
  texture: THREE.DataTexture;
}

export class MaterialMasks {
  private library = new Map<string, string>();
  private libraryKey = "";
  private poll: ReturnType<typeof setInterval> | null = null;
  // Each rock's texels, by its build's hash: rasterised once a rock.
  private readonly texels = new Map<string, MaskTexels | "loading" | "failed">();
  // Each patch's mask, by decoration id.
  private readonly live = new Map<string, Live>();
  // The bakes asked for, and those known to be in the store.
  private readonly asked = new Set<string>();
  private readonly baked = new Set<string>();
  // The bakes whose failure has been told.
  private readonly warned = new Set<string>();

  // `changed`: what the scene draws for a material layer has changed (a bake
  // landed, a rock's texels are ready, the library moved), so it must be
  // built again; `libraryChanged`: the palette's list.
  constructor(
    private readonly model: () => EdModel,
    private readonly jobs: FormationJobs,
    private readonly changed: () => void,
    private readonly libraryChanged: () => void,
  ) {}

  // --- the library ------------------------------------------------------------

  get materials(): readonly string[] {
    return [...this.library.keys()];
  }

  libraryOf(material: string): string | null {
    return this.library.get(material) ?? null;
  }

  async refreshLibrary(): Promise<void> {
    try {
      const res = await fetch(MATERIALS_API, { cache: "no-store" });
      if (!res.ok) return;
      const { materials } = (await res.json()) as { materials: MaterialLibraryEntry[] };
      const key = JSON.stringify(materials);
      if (key === this.libraryKey) return;
      this.libraryKey = key;
      this.library = new Map(materials.map((m) => [m.name, m.library]));
      this.libraryChanged();
      this.changed();
    } catch {
      // The dev server is away: the library stays as it was.
    }
  }

  // Watch the library (while the Texturing workspace is open), or stop.
  watchLibrary(on: boolean): void {
    if (on && !this.poll) {
      void this.refreshLibrary();
      this.poll = setInterval(() => void this.refreshLibrary(), LIBRARY_POLL_MS);
    } else if (!on && this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  // --- what the scene draws ---------------------------------------------------

  // A finished job: a material baked onto a rock. One that failed on a rock
  // generated before the paint UV says so where it is seen, not only in the
  // jobs list: the rock must be generated again (2026-11-26, Tris painted
  // dirt on such a rock and saw nothing).
  onJob(job: JobState): void {
    if (job.kind === "material" && job.state === "failed" && /generated before texture layers/.test(job.error ?? "") && !this.warned.has(job.hash)) {
      this.warned.add(job.hash);
      showToast("This rock was generated before materials could be painted on it: Generate it again (Formations workspace) and the paint shows.", "warn");
    }
    if (job.kind !== "material" || job.state !== "done" || this.baked.has(job.hash)) return;
    this.baked.add(job.hash);
    this.changed();
  }

  // What to draw for `o` (`setMaterialLayerSource`): its material as baked
  // onto its rock now, with the mask of its strokes now; what was built,
  // while either is on its way; nothing before anything is.
  draw(o: DecorationObjectData): MaterialLayerDraw | null {
    const d = this.itemOf(o.id);
    const host = d ? this.hostOf(d) : null;
    const material = materialOf(o);
    const library = this.library.get(material);
    if (d && host && library) {
      const maps = materialLayerHash({ host, material, library });
      if (o.built?.maps === maps) this.baked.add(maps);
      if (this.isBaked(maps)) {
        const mask = this.maskOf(d, host);
        if (mask) return { maps, mask };
      } else this.bake(host, material, library, maps);
    }
    return o.built?.maps ? { maps: o.built.maps, mask: paintLayerTexture(decorationMaskFile(o.built.hash), true) } : null;
  }

  // Whether `d` is drawn live (its material baked and its mask computed).
  drawsLive(d: EdItem): boolean {
    const dec = d.decoration;
    if (!dec || !isMaterialLayer(dec)) return false;
    const host = this.hostOf(d);
    const library = this.library.get(materialOf(dec));
    if (!host || !library) return false;
    const live = this.live.get(dec.id);
    return !!live && live.host === host && this.isBaked(materialLayerHash({ host, material: materialOf(dec), library }));
  }

  // What the scene's key holds for `o`: a change of it builds the scene again.
  drawKey(o: DecorationObjectData): string {
    const draw = this.draw(o);
    return draw ? `${draw.maps}|${draw.mask.uuid}` : "";
  }

  // Once a frame: each live mask brought to its patch's strokes. Masks of
  // patches gone, or of a rock no longer theirs, are let go.
  sync(): void {
    const seen = new Set<string>();
    for (const d of this.model().items) {
      const dec = d.decoration;
      if (!dec || !isMaterialLayer(dec)) continue;
      seen.add(dec.id);
      const live = this.live.get(dec.id);
      if (!live) continue;
      if (live.host !== this.hostOf(d)) {
        this.drop(dec.id);
        this.changed();
        continue;
      }
      if (live.mask.update(dec.strokes ?? [])) {
        live.mask.write(live.data);
        live.texture.needsUpdate = true;
      }
    }
    for (const id of [...this.live.keys()]) if (!seen.has(id)) this.drop(id);
  }

  // A rock rebuilt (a Generate landed on it, under the same hash or a new
  // one): its texels are read again from its new mesh, and every mask over
  // it is made again.
  forgetRock(host: string): void {
    this.texels.delete(host);
    // A bake that failed on the old rock may be asked again on the new one.
    for (const maps of [...this.asked]) if (this.jobs.latest(maps)?.state === "failed") this.asked.delete(maps);
    for (const [id, live] of [...this.live]) if (live.host === host) this.drop(id);
    this.changed();
  }

  // --- inside -----------------------------------------------------------------

  private isBaked(maps: string): boolean {
    return this.baked.has(maps) || this.jobs.latest(maps)?.state === "done";
  }

  private bake(host: string, material: string, library: string, maps: string): void {
    if (this.asked.has(maps)) return;
    this.asked.add(maps);
    void fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "material", material: { host, material, library }, label: `${material} on ${host.slice(0, 8)}` }),
    }).catch(() => this.asked.delete(maps));
  }

  private maskOf(d: EdItem, host: string): THREE.Texture | null {
    const dec = d.decoration!;
    const had = this.live.get(dec.id);
    if (had && had.host === host) return had.texture;
    if (had) this.drop(dec.id);
    const texels = this.texelsOf(host);
    if (!texels) return null;
    const mask = new MaterialMask(texels);
    mask.update(dec.strokes ?? []);
    const data = mask.write(new Uint8Array(MASK_SIDE * MASK_SIDE));
    const texture = new THREE.DataTexture(data, MASK_SIDE, MASK_SIDE, THREE.RedFormat, THREE.UnsignedByteType);
    texture.flipY = false;
    texture.colorSpace = THREE.NoColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    this.live.set(dec.id, { host, mask, data, texture });
    return texture;
  }

  // A rock's texels: rasterised from its iteration mesh once it has loaded.
  private texelsOf(host: string): MaskTexels | null {
    const have = this.texels.get(host);
    if (have) return typeof have === "string" ? null : have;
    this.texels.set(host, "loading");
    void loadFormationFile({ file: `${FORMATION_STORE}/${host}/${GEOMETRY_FILE}`, bytes: 1, baked: false }).then((rock) => {
      const meshes = rock ? paintUvMeshes(rock) : [];
      if (!meshes.length) {
        this.texels.set(host, "failed");
        return;
      }
      this.texels.set(host, rasterizePaintUv(meshes, MASK_SIDE));
      this.changed();
    });
    return null;
  }

  private drop(id: string): void {
    this.live.get(id)?.texture.dispose();
    this.live.delete(id);
  }

  private itemOf(decorationId: string): EdItem | null {
    return this.model().items.find((i) => i.decoration?.id === decorationId) ?? null;
  }

  private hostOf(d: EdItem): string | null {
    // Its rock: the formation it grows on, its parent.
    const f = this.model().items.find((i) => i.object === "formation" && i.formation?.id === d.decoration?.formation);
    return f?.formation?.built?.hash ?? null;
  }
}

// The loaded iteration mesh's triangles, in the formation's frame, with the
// paint UV (`uv`, which formationSlate.ts keeps).
export function paintUvMeshes(rock: THREE.Object3D): PaintUvMesh[] {
  rock.updateMatrixWorld(true);
  const out: PaintUvMesh[] = [];
  const v = new THREE.Vector3();
  rock.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const pos = g.getAttribute("position");
    const uv = g.getAttribute("uv");
    if (!pos || !uv) return;
    const positions = new Float32Array(pos.count * 3);
    const uvs = new Float32Array(uv.count * 2);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = v.y;
      positions[i * 3 + 2] = v.z;
      uvs[i * 2] = uv.getX(i);
      uvs[i * 2 + 1] = uv.getY(i);
    }
    const index = g.index ? Uint32Array.from(g.index.array as ArrayLike<number>) : Uint32Array.from({ length: pos.count }, (_, i) => i);
    out.push({ positions, uvs, index });
  });
  return out;
}
