import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

/** Read the host's visible triangles into the frame of the vine object. */
export function vineSurfaceSoup(meshes: readonly THREE.Mesh[], frame: THREE.Matrix4, limit = 90000): Float32Array {
  const inverse = frame.clone().invert();
  const point = new THREE.Vector3();
  const values: number[] = [];
  let triangles = 0;
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const attr = mesh.geometry.getAttribute("position");
    if (!attr) continue;
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : attr.count;
    const worldToVine = inverse.clone().multiply(mesh.matrixWorld);
    // A negative scale changes handedness. Keep outward face normals by
    // reversing the triangle in the frame supplied to the generator.
    const winding = worldToVine.determinant() < 0 ? [0, 2, 1] : [0, 1, 2];
    for (let i = 0; i + 2 < count; i += 3) {
      if (++triangles > limit) throw new Error("This surface has too many faces for one vine.");
      for (let j = 0; j < 3; j++) {
        const at = index ? index.getX(i + winding[j]!) : i + winding[j]!;
        point.fromBufferAttribute(attr, at).applyMatrix4(worldToVine);
        values.push(point.x, point.y, point.z);
      }
    }
  }
  if (!values.length) throw new Error("The selected model has no drawable surface.");
  return new Float32Array(values);
}

export async function exportHangingVine(group: THREE.Group): Promise<ArrayBuffer> {
  const data = await new GLTFExporter().parseAsync(group, { binary: true, onlyVisible: true });
  if (!(data instanceof ArrayBuffer)) throw new Error("The vine could not be exported as a GLB.");
  return data;
}

export function glbBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000)
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(chunks.join(""));
}
