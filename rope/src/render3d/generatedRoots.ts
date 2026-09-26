// Immutable local assets: carrying the size in the key also lets saved levels
// preload generated meshes without a mutable, session-only manifest.
export function generatedRootAsset(key: string): { file: string; bytes: number } | undefined {
  const match = /^root:([a-f0-9-]{36}):([1-9][0-9]*)$/.exec(key);
  if (!match) return undefined;
  const bytes = Number(match[2]);
  if (!Number.isSafeInteger(bytes)) return undefined;
  return { file: `/generated-roots/${match[1]}/roots_LOD0.glb`, bytes };
}
