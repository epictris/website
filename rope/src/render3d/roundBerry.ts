import * as THREE from "three";

const hash = (x: number, y: number, z: number): number => {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
};

// Smooth pigment drift; interpolation avoids hard cell edges in the emitted light.
function pigment(x: number, y: number, z: number, scale: number): number {
  x *= scale; y *= scale * 0.8; z *= scale;
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const smooth = (v: number) => v * v * (3 - 2 * v);
  const fx = smooth(x - ix), fy = smooth(y - iy), fz = smooth(z - iz);
  let color = 0;
  for (let a = 0; a <= 1; a++) for (let b = 0; b <= 1; b++) for (let c = 0; c <= 1; c++) {
    color += hash(ix + a, iy + b, iz + c) * (a ? fx : 1 - fx)
      * (b ? fy : 1 - fy) * (c ? fz : 1 - fz);
  }
  return color;
}

/** A warm, continuous inner glow with very subtle skin colour variation. */
export function roundBerryTexture(): THREE.DataTexture {
  const width = 256, height = 128, pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const phi = x / (width - 1) * Math.PI * 2, theta = (1 - y / (height - 1)) * Math.PI;
    const nx = -Math.cos(phi) * Math.sin(theta), ny = Math.cos(theta), nz = Math.sin(phi) * Math.sin(theta);
    const broad = pigment(nx, ny, nz, 3);
    const core = 0.34 + 0.6 * Math.pow(Math.max(0, nz), 0.85);
    const value = core * (0.94 + broad * 0.06);
    const at = (y * width + x) * 4;
    pixels[at] = Math.round(255 * Math.min(1, value * 1.3));
    pixels[at + 1] = Math.round(255 * value * 0.76);
    pixels[at + 2] = Math.round(255 * value * (0.07 + Math.max(0, value - 0.55) * 0.85));
    pixels[at + 3] = 255;
  }
  const texture = new THREE.DataTexture(pixels, width, height);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  return texture;
}

/** A softly asymmetric, slightly oval berry, with a rounded bottom. */
function berryShape(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    p.setXYZ(i, x * (0.91 + 0.04 * y + 0.02 * z) + 0.025 * (1 - y * y),
      y + 0.015 * (1 - y * y) * x, z * 0.92);
  }
  p.needsUpdate = true; g.computeVertexNormals();
  return g;
}

export function roundBerryGeometry(): THREE.BufferGeometry {
  return berryShape(new THREE.SphereGeometry(1, 48, 32));
}

/** A short green collar grows into five ribbed sepals with lifted, tapered tips. */
export function roundBerryCalyx(): THREE.BufferGeometry {
  const positions: number[] = [], uv: number[] = [], colors: number[] = [], indices: number[] = [];
  const rows = 14, columns = [-1, -0.22, 0, 0.22, 1];
  for (let leaf = 0; leaf < 5; leaf++) {
    const start = positions.length / 3;
    for (let row = 0; row <= rows; row++) {
      const t = row / rows, theta = 0.1 + t * (0.91 + 0.12 * Math.sin(leaf * 3));
      const width = Math.pow(Math.sin(Math.PI * t), 0.85) * 0.43;
      for (const col of columns) {
        const angle = leaf * Math.PI * 2 / 5 + col * width + Math.sin(t * Math.PI) * 0.06 * Math.sin(leaf * 4);
        const ridge = (1 - Math.abs(col)) * Math.sin(Math.PI * t) * 0.045;
        const r = 1.045 + Math.pow(t, 5) * 0.28 + ridge;
        positions.push(Math.sin(theta) * Math.cos(angle) * r, Math.cos(theta) * r,
          Math.sin(theta) * Math.sin(angle) * r);
        uv.push((col + 1) / 2, t);
        const tone = col === 0 ? 1 : Math.abs(col) < 0.3 ? 0.77 : 0.66;
        colors.push(tone * (0.8 + leaf * 0.025), tone, tone * 0.66);
      }
      if (row < rows) for (let col = 0; col < columns.length - 1; col++) {
        const a = start + row * columns.length + col, b = a + columns.length;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const collar = positions.length / 3;
  for (let ring = 0; ring < 2; ring++) for (let i = 0; i <= 12; i++) {
    const angle = i / 12 * Math.PI * 2, radius = ring ? 0.12 : 0.18;
    positions.push(Math.cos(angle) * radius, ring ? 1.15 : 0.99, Math.sin(angle) * radius);
    uv.push(i / 12, ring); colors.push(0.8, 0.9, 0.58);
    if (!ring && i < 12) {
      const a = collar + i; indices.push(a, a + 1, a + 13, a + 1, a + 14, a + 13);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(indices); g.computeVertexNormals();
  return berryShape(g);
}
