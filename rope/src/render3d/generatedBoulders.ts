export function generatedBoulderAsset(key: string): { file: string; bytes: number } | undefined {
  const match = /^boulder-v5:([a-f0-9-]{36}):([1-9][0-9]*)$/.exec(key);
  if (!match) return undefined;
  const bytes = Number(match[2]);
  if (!Number.isSafeInteger(bytes)) return undefined;
  return { file: `/generated-boulders/${match[1]}/boulder.glb`, bytes };
}
