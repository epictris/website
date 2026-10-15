// Stable growth coordinates shared by braid nodes and leaf attachments.
export function vineRandom(seed: number, item: number, salt: number): number {
  const n = Math.sin((seed + 1) * 127.1 + (item + 1) * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

export function vineNodeCount(length: number): number { return Math.max(0, Math.round(length / .95)); }
export function vineNodeFraction(seed: number, node: number, count: number): number {
  // Unequal growth intervals give clusters and bare stretches, rather than
  // jittering a node inside every identical cell. Include both end gaps.
  let before = 0, total = 0;
  for (let gap = 0; gap <= count; gap++) {
    const weight = .32 + 1.8 * vineRandom(seed, gap, 0) ** 2;
    total += weight;
    if (gap <= node) before += weight;
  }
  return .04 + .88 * before / total;
}
