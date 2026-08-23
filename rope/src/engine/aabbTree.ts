// Dynamic AABB tree broadphase (Box2D's b2DynamicTree design): every leaf holds
// one collision shape under a FAT box - its tight box grown by a fixed margin -
// so a shape that jitters in place never touches the tree, and a static shape
// inserted at load is never touched again. Internal nodes are managed with the
// surface-area heuristic on insertion and kept shallow with AVL rotations.
//
// The tree answers CANDIDATES, never contacts: a query returns every leaf whose
// fat box meets the query region, which is a strict superset of every leaf
// whose tight box does - callers keep their own exact per-shape tests, so the
// accepted set (and therefore every recorded replay) is bit-identical to the
// full scan this replaces. Callers that care about order must sort the
// candidates themselves: tree shape depends on insertion history, and iteration
// order here is not part of the contract.

// How much a leaf's box is grown beyond the shape's tight box, in metres.
// Larger = fewer re-insertions for a moving body, more false candidates.
const FAT_MARGIN = 0.06;

const NULL_NODE = -1;

interface TreeNode<T> {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  parent: number;
  child1: number;
  child2: number;
  // 0 for a leaf, -1 for a free node.
  height: number;
  userData: T | null;
}

export class AABBTree<T> {
  private readonly nodes: TreeNode<T>[] = [];
  private root = NULL_NODE;
  private freeList = NULL_NODE;

  private allocateNode(): number {
    if (this.freeList !== NULL_NODE) {
      const id = this.freeList;
      const n = this.nodes[id]!;
      this.freeList = n.parent;
      n.parent = NULL_NODE;
      n.child1 = NULL_NODE;
      n.child2 = NULL_NODE;
      n.height = 0;
      n.userData = null;
      return id;
    }
    this.nodes.push({
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      parent: NULL_NODE,
      child1: NULL_NODE,
      child2: NULL_NODE,
      height: 0,
      userData: null,
    });
    return this.nodes.length - 1;
  }

  private freeNode(id: number): void {
    const n = this.nodes[id]!;
    n.parent = this.freeList;
    n.height = -1;
    n.userData = null;
    this.freeList = id;
  }

  // Insert a leaf for `userData` covering the TIGHT box given; the stored box
  // is fattened by the margin. Returns the proxy id used by move/remove.
  insert(userData: T, minX: number, minY: number, maxX: number, maxY: number): number {
    const leaf = this.allocateNode();
    const n = this.nodes[leaf]!;
    n.minX = minX - FAT_MARGIN;
    n.minY = minY - FAT_MARGIN;
    n.maxX = maxX + FAT_MARGIN;
    n.maxY = maxY + FAT_MARGIN;
    n.userData = userData;
    n.height = 0;
    this.insertLeaf(leaf);
    return leaf;
  }

  remove(proxy: number): void {
    this.removeLeaf(proxy);
    this.freeNode(proxy);
  }

  // Update a proxy to a new tight box. A no-op while the tight box still fits
  // inside the stored fat box - the common case for a body settling in place -
  // otherwise the leaf is re-inserted around a re-fattened box.
  move(proxy: number, minX: number, minY: number, maxX: number, maxY: number): void {
    const n = this.nodes[proxy]!;
    if (minX >= n.minX && minY >= n.minY && maxX <= n.maxX && maxY <= n.maxY) return;
    this.removeLeaf(proxy);
    n.minX = minX - FAT_MARGIN;
    n.minY = minY - FAT_MARGIN;
    n.maxX = maxX + FAT_MARGIN;
    n.maxY = maxY + FAT_MARGIN;
    this.insertLeaf(proxy);
  }

  // Every leaf whose fat box meets the query box (inclusive at the boundary),
  // appended to `out` in tree order.
  query(minX: number, minY: number, maxX: number, maxY: number, out: T[]): void {
    if (this.root === NULL_NODE) return;
    const stack: number[] = [this.root];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const n = this.nodes[id]!;
      if (n.minX > maxX || n.maxX < minX || n.minY > maxY || n.maxY < minY) continue;
      if (n.height === 0) {
        out.push(n.userData!);
      } else {
        stack.push(n.child1, n.child2);
      }
    }
  }

  // Every leaf whose fat box is crossed by the segment a→b (inclusive), appended
  // to `out` in tree order. Degenerate segments behave as a point query.
  querySegment(ax: number, ay: number, bx: number, by: number, out: T[]): void {
    if (this.root === NULL_NODE) return;
    const dx = bx - ax;
    const dy = by - ay;
    const stack: number[] = [this.root];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const n = this.nodes[id]!;
      if (!segmentMeetsBox(ax, ay, dx, dy, n)) continue;
      if (n.height === 0) {
        out.push(n.userData!);
      } else {
        stack.push(n.child1, n.child2);
      }
    }
  }

  private insertLeaf(leaf: number): void {
    if (this.root === NULL_NODE) {
      this.root = leaf;
      this.nodes[leaf]!.parent = NULL_NODE;
      return;
    }

    // Descend to the best sibling by the surface-area heuristic: at each node,
    // compare the cost of making this node the sibling against the cost of
    // pushing the leaf into either child.
    const ln = this.nodes[leaf]!;
    let index = this.root;
    while (this.nodes[index]!.height > 0) {
      const node = this.nodes[index]!;
      const area = perimeter(node);
      const combinedArea = unionPerimeter(node, ln);
      // Cost of creating a new parent for this node and the leaf.
      const cost = 2 * combinedArea;
      // Minimum cost of pushing the leaf further down the tree.
      const inheritance = 2 * (combinedArea - area);
      const cost1 = descendCost(this.nodes[node.child1]!, ln) + inheritance;
      const cost2 = descendCost(this.nodes[node.child2]!, ln) + inheritance;
      if (cost < cost1 && cost < cost2) break;
      index = cost1 < cost2 ? node.child1 : node.child2;
    }

    // Splice a new parent in above the chosen sibling.
    const sibling = index;
    const oldParent = this.nodes[sibling]!.parent;
    const newParent = this.allocateNode();
    const pn = this.nodes[newParent]!;
    pn.parent = oldParent;
    pn.height = this.nodes[sibling]!.height + 1;
    growToUnion(pn, this.nodes[sibling]!, ln);
    pn.child1 = sibling;
    pn.child2 = leaf;
    this.nodes[sibling]!.parent = newParent;
    ln.parent = newParent;
    if (oldParent === NULL_NODE) {
      this.root = newParent;
    } else {
      const op = this.nodes[oldParent]!;
      if (op.child1 === sibling) op.child1 = newParent;
      else op.child2 = newParent;
    }

    this.refitAncestors(ln.parent);
  }

  private removeLeaf(leaf: number): void {
    if (leaf === this.root) {
      this.root = NULL_NODE;
      return;
    }
    const parent = this.nodes[leaf]!.parent;
    const pn = this.nodes[parent]!;
    const sibling = pn.child1 === leaf ? pn.child2 : pn.child1;
    const grandParent = pn.parent;
    // The parent is collapsed away and the sibling takes its place.
    this.nodes[sibling]!.parent = grandParent;
    if (grandParent === NULL_NODE) {
      this.root = sibling;
    } else {
      const gp = this.nodes[grandParent]!;
      if (gp.child1 === parent) gp.child1 = sibling;
      else gp.child2 = sibling;
    }
    this.freeNode(parent);
    this.refitAncestors(grandParent);
  }

  // Walk from `index` to the root re-balancing and re-computing each node's
  // height and box - the shared tail of insert and remove.
  private refitAncestors(index: number): void {
    while (index !== NULL_NODE) {
      index = this.balance(index);
      const n = this.nodes[index]!;
      const c1 = this.nodes[n.child1]!;
      const c2 = this.nodes[n.child2]!;
      n.height = 1 + Math.max(c1.height, c2.height);
      growToUnion(n, c1, c2);
      index = n.parent;
    }
  }

  // One AVL rotation at `iA` if its children's heights differ by more than 1.
  // Returns the index now occupying iA's place.
  private balance(iA: number): number {
    const A = this.nodes[iA]!;
    if (A.height < 2) return iA;
    const iB = A.child1;
    const iC = A.child2;
    const B = this.nodes[iB]!;
    const C = this.nodes[iC]!;
    const bal = C.height - B.height;

    if (bal > 1) return this.rotate(iA, iC, iB);
    if (bal < -1) return this.rotate(iA, iB, iC);
    return iA;
  }

  // Promote the taller child `iUp` above `iA`; `iOther` stays put. The taller
  // child's shorter grandchild is adopted by iA.
  private rotate(iA: number, iUp: number, iOther: number): number {
    const A = this.nodes[iA]!;
    const up = this.nodes[iUp]!;
    const iF = up.child1;
    const iG = up.child2;
    const F = this.nodes[iF]!;
    const G = this.nodes[iG]!;

    // iUp replaces iA in the tree.
    up.parent = A.parent;
    if (A.parent !== NULL_NODE) {
      const p = this.nodes[A.parent]!;
      if (p.child1 === iA) p.child1 = iUp;
      else p.child2 = iUp;
    } else {
      this.root = iUp;
    }

    const keep = F.height > G.height ? iF : iG;
    const give = F.height > G.height ? iG : iF;
    const kept = this.nodes[keep]!;
    const given = this.nodes[give]!;

    up.child1 = iA;
    up.child2 = keep;
    A.parent = iUp;
    kept.parent = iUp;

    if (A.child1 === iUp) A.child1 = give;
    else A.child2 = give;
    given.parent = iA;

    const other = this.nodes[iOther]!;
    growToUnion(A, other, given);
    A.height = 1 + Math.max(other.height, given.height);
    growToUnion(up, A, kept);
    up.height = 1 + Math.max(A.height, kept.height);
    return iUp;
  }
}

function perimeter(n: { minX: number; minY: number; maxX: number; maxY: number }): number {
  return 2 * (n.maxX - n.minX + (n.maxY - n.minY));
}

function unionPerimeter(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number },
): number {
  const minX = Math.min(a.minX, b.minX);
  const minY = Math.min(a.minY, b.minY);
  const maxX = Math.max(a.maxX, b.maxX);
  const maxY = Math.max(a.maxY, b.maxY);
  return 2 * (maxX - minX + (maxY - minY));
}

function growToUnion<T>(
  dst: TreeNode<T>,
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number },
): void {
  dst.minX = Math.min(a.minX, b.minX);
  dst.minY = Math.min(a.minY, b.minY);
  dst.maxX = Math.max(a.maxX, b.maxX);
  dst.maxY = Math.max(a.maxY, b.maxY);
}

// SAH cost of descending the leaf `ln` into child `child`: the child's grown
// perimeter, minus its current one when it is not a leaf (Box2D's form).
function descendCost<T>(child: TreeNode<T>, ln: TreeNode<T>): number {
  const grown = unionPerimeter(child, ln);
  return child.height === 0 ? grown : grown - perimeter(child);
}

// Slab test: does the segment starting at (ax, ay) with delta (dx, dy) meet the
// node's box? Inclusive at boundaries; a zero-delta axis degenerates to a range
// check on that axis.
function segmentMeetsBox(
  ax: number,
  ay: number,
  dx: number,
  dy: number,
  n: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  let tmin = 0;
  let tmax = 1;
  if (dx === 0) {
    if (ax < n.minX || ax > n.maxX) return false;
  } else {
    const inv = 1 / dx;
    let t1 = (n.minX - ax) * inv;
    let t2 = (n.maxX - ax) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  if (dy === 0) {
    if (ay < n.minY || ay > n.maxY) return false;
  } else {
    const inv = 1 / dy;
    let t1 = (n.minY - ay) * inv;
    let t2 = (n.maxY - ay) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}
