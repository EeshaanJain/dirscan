// Columnar directory tree shared by the snapshot loader and the live event reducer.
// Row index == dir id; a parent always has a smaller id than its children.

export const F_UNREADABLE = 1
export const F_VISITED = 2
export const F_COMPLETE = 4

export class Tree {
  /** number of dirs */
  n = 0
  cap: number
  parent: Int32Array
  firstChild: Int32Array
  nextSibling: Int32Array
  ownBytes: Float64Array
  ownFiles: Float64Array
  totalBytes: Float64Array
  totalFiles: Float64Array
  flags: Uint8Array
  /** live mode only: dirs in this subtree (itself included) not yet scanned */
  pending: Int32Array
  names: string[] = []
  /** bumped on every structural or numeric change, for cheap memo invalidation */
  version = 0

  constructor(capacity = 1024) {
    this.cap = Math.max(1, capacity)
    this.parent = new Int32Array(this.cap)
    this.firstChild = new Int32Array(this.cap).fill(-1)
    this.nextSibling = new Int32Array(this.cap).fill(-1)
    this.ownBytes = new Float64Array(this.cap)
    this.ownFiles = new Float64Array(this.cap)
    this.totalBytes = new Float64Array(this.cap)
    this.totalFiles = new Float64Array(this.cap)
    this.flags = new Uint8Array(this.cap)
    this.pending = new Int32Array(this.cap)
  }

  private grow(min: number) {
    let cap = this.cap
    while (cap < min) cap *= 2
    const g = <T extends Int32Array | Float64Array | Uint8Array>(a: T, fill = 0): T => {
      const b = new (a.constructor as new (n: number) => T)(cap)
      b.set(a)
      if (fill) b.fill(fill, a.length)
      return b
    }
    this.parent = g(this.parent)
    this.firstChild = g(this.firstChild, -1)
    this.nextSibling = g(this.nextSibling, -1)
    this.ownBytes = g(this.ownBytes)
    this.ownFiles = g(this.ownFiles)
    this.totalBytes = g(this.totalBytes)
    this.totalFiles = g(this.totalFiles)
    this.flags = g(this.flags)
    this.pending = g(this.pending)
    this.cap = cap
  }

  /** Append a dir. Ids must arrive in order (id === n). */
  addDir(id: number, parent: number, name: string) {
    if (id !== this.n) throw new Error(`dir id ${id} out of order (expected ${this.n})`)
    if (parent >= id) throw new Error(`dir ${id} has parent ${parent} >= its own id`)
    if (id >= this.cap) this.grow(id + 1)
    this.parent[id] = parent
    this.names[id] = name
    this.n = id + 1
    if (parent >= 0) {
      this.nextSibling[id] = this.firstChild[parent]
      this.firstChild[parent] = id
    }
    this.version++
  }

  /** Child ids of `id` (most recently discovered first). */
  children(id: number): number[] {
    const out: number[] = []
    for (let c = this.firstChild[id]; c !== -1; c = this.nextSibling[c]) out.push(c)
    return out
  }

  childCount(id: number): number {
    let k = 0
    for (let c = this.firstChild[id]; c !== -1; c = this.nextSibling[c]) k++
    return k
  }

  isComplete(id: number): boolean {
    return (this.flags[id] & F_COMPLETE) !== 0
  }
  isVisited(id: number): boolean {
    return (this.flags[id] & F_VISITED) !== 0
  }
  isUnreadable(id: number): boolean {
    return (this.flags[id] & F_UNREADABLE) !== 0
  }
}

/** Absolute path of a dir: root path joined with the names below row 0. */
export function pathOf(tree: Tree, root: string, id: number): string {
  if (id <= 0) return root
  const parts: string[] = []
  for (let i = id; i > 0; i = tree.parent[i]) parts.push(tree.names[i])
  parts.reverse()
  return (root.endsWith('/') ? root : root + '/') + parts.join('/')
}

/** Ids from the root down to `id`, inclusive. */
export function ancestry(tree: Tree, id: number): number[] {
  const out: number[] = []
  for (let i = id; i >= 0; i = tree.parent[i]) out.push(i)
  return out.reverse()
}

/**
 * Subtree membership test for `ancestor`, memoized per dir id. Walks parents until it
 * hits `ancestor` (in), the root (out) or an already-decided dir.
 */
export function makeSubtreeTester(tree: Tree, ancestor: number): (dir: number) => boolean {
  if (ancestor === 0) return () => true
  let memo = new Uint8Array(Math.max(tree.n, 1)) // 0 unknown, 1 inside, 2 outside
  const stack: number[] = []
  return (dir: number) => {
    if (dir >= memo.length) {
      const m = new Uint8Array(Math.max(tree.n, dir + 1))
      m.set(memo)
      memo = m
    }
    stack.length = 0
    let i = dir
    let verdict = 2
    while (i >= 0) {
      if (i === ancestor) {
        verdict = 1
        break
      }
      if (memo[i]) {
        verdict = memo[i]
        break
      }
      stack.push(i)
      i = tree.parent[i]
    }
    for (const s of stack) memo[s] = verdict
    return verdict === 1
  }
}
