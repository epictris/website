export function generatedDirtMossAsset(key: string): { file: string; bytes: number } | undefined {
  const match = /^dirt-moss:([a-f0-9-]{36}):([1-9][0-9]*)$/.exec(key);
  if (!match) return undefined;
  const bytes = Number(match[2]);
  if (!Number.isSafeInteger(bytes)) return undefined;
  return { file: `/generated-dirt-moss/${match[1]}/dirt.glb`, bytes };
}
