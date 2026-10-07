export function generatedVineAsset(key: string): { file: string; bytes: number } | undefined {
  const match = /^(?:vine-v3|foliage-v1):([a-f0-9-]{36}):([1-9][0-9]*)$/.exec(key);
  if (!match) return undefined;
  const bytes = Number(match[2]);
  if (!Number.isSafeInteger(bytes)) return undefined;
  return { file: `/generated-vines/${match[1]}/vine.glb`, bytes };
}
