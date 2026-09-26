export function generatedGrassAsset(key: string): { file: string; bytes: number } | undefined {
  const match = /^grass-patch:([a-f0-9-]{36}):([1-9][0-9]*)$/.exec(key);
  if (!match) return undefined;
  const bytes = Number(match[2]);
  if (!Number.isSafeInteger(bytes)) return undefined;
  return { file: `/generated-grass/${match[1]}/grass.glb`, bytes };
}
