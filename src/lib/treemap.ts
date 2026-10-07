// Two-level squarified treemap layout of one directory.
//
//  level 1: the dir's children by total_bytes, plus a "(files)" tile for the dir's own files
//  level 2: inside each big level-1 tile, that dir's children (and its own "(files)")
//
// At most MAX_TILES rectangles come out; whatever doesn't fit is rolled into "other (N)"
// tiles. Dirs that have no bytes yet because the scan hasn't reached them are rolled into a
// single "pending (N)" tile per parent, so a live scan visibly has work left.

import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy'
import type { Tree } from './tree'

export const MAX_TILES = 400
const MAX_LEVEL1 = 150
export const LABEL_STRIP = 14
/** a level-1 tile gets a label strip and children only if at least this big */
const MIN_NESTED_W = 60
const MIN_NESTED_H = 36
const MIN_CHILD_AREA = 8

export type TileKind = 'dir' | 'files' | 'other' | 'pending'

export interface Tile {
  /** stable across re-layouts, so the same tile can be animated and kept hovered */
  key: string
  kind: TileKind
  level: 1 | 2
  /** dir id: the dir itself for 'dir', the owning dir for 'files'/'other'/'pending' */
  id: number
  /** dir id of the level-1 tile this one sits in, or -1 */
  parent: number
  /** discovery index of the level-1 ancestor among its siblings (colour group), -1 = neutral */
  group: number
  label: string
  bytes: number
  files: number
  /** bytes is only a lower bound: the subtree isn't fully scanned */
  lower: boolean
  /** how many dirs an 'other'/'pending' tile stands for */
  count: number
  complete: boolean
  /** level-1 tile that reserved room for a label strip above its children */
  strip: boolean
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  tiles: Tile[]
  /** bytes of the laid-out dir as the tree currently knows it */
  total: number
}

interface Item {
  key: string
  kind: TileKind
  id: number
  label: string
  value: number
  files: number
  lower: boolean
  count: number
  complete: boolean
  group: number
  children?: Item[]
}

/** Keeps the K largest of a stream, O(n log K), for dirs with very many children. */
class TopK<T> {
  private heap: { v: number; item: T }[] = []
  private k: number
  constructor(k: number) {
    this.k = k
  }
  /** returns the evicted (or rejected) item if there was one */
  push(v: number, item: T): { v: number; item: T } | null {
    const h = this.heap
    if (h.length < this.k) {
      h.push({ v, item })
      this.up(h.length - 1)
      return null
    }
    if (v <= h[0].v) return { v, item }
    const out = h[0]
    h[0] = { v, item }
    this.down(0)
    return out
  }
  sorted() {
    return [...this.heap].sort((a, b) => b.v - a.v).map((e) => e.item)
  }
  private up(i: number) {
    const h = this.heap
    while (i > 0) {
      const p = (i - 1) >> 1
      if (h[p].v <= h[i].v) break
      ;[h[p], h[i]] = [h[i], h[p]]
      i = p
    }
  }
  private down(i: number) {
    const h = this.heap
    for (;;) {
      let m = i
      const l = 2 * i + 1
      const r = l + 1
      if (l < h.length && h[l].v < h[m].v) m = l
      if (r < h.length && h[r].v < h[m].v) m = r
      if (m === i) return
      ;[h[m], h[i]] = [h[i], h[m]]
      i = m
    }
  }
}

/** Items for the children (and own files) of `dir`, at most `cap` of them. */
function gather(tree: Tree, dir: number, cap: number, level: 1 | 2, parentGroup: number): Item[] {
  const items: Item[] = []
  const ownBytes = tree.ownBytes[dir]
  const hasFiles = ownBytes > 0
  const reserved = (hasFiles ? 1 : 0) + 2 // room for files, other, pending
  const dirCap = Math.max(1, cap - reserved)

  const top = new TopK<{ id: number; pos: number }>(dirCap)
  let n = 0
  let pendingCount = 0
  let otherBytes = 0
  let otherFiles = 0
  let otherCount = 0
  let otherLower = false
  const consume = (e: { v: number; item: { id: number; pos: number } } | null) => {
    if (!e) return
    otherBytes += e.v
    otherFiles += tree.totalFiles[e.item.id]
    otherCount++
    otherLower ||= !tree.isComplete(e.item.id)
  }
  for (let c = tree.firstChild[dir]; c !== -1; c = tree.nextSibling[c]) {
    const pos = n++
    const bytes = tree.totalBytes[c]
    if (bytes > 0) consume(top.push(bytes, { id: c, pos }))
    else if (!tree.isComplete(c)) pendingCount++
  }

  for (const { id, pos } of top.sorted()) {
    items.push({
      key: `d:${id}`,
      kind: 'dir',
      id,
      label: tree.names[id],
      value: tree.totalBytes[id],
      files: tree.totalFiles[id],
      lower: !tree.isComplete(id),
      count: 1,
      complete: tree.isComplete(id),
      // children are listed newest first, so discovery order is counted from the end
      group: level === 1 ? n - 1 - pos : parentGroup,
    })
  }
  if (hasFiles) {
    items.push({
      key: `f:${dir}`, kind: 'files', id: dir, label: '(files)', value: ownBytes,
      files: tree.ownFiles[dir], lower: false, count: 0, complete: true, group: level === 1 ? -1 : parentGroup,
    })
  }
  if (otherCount) {
    items.push({
      key: `o:${dir}`, kind: 'other', id: dir, label: `other (${otherCount.toLocaleString('en-US')})`, value: otherBytes,
      files: otherFiles, lower: otherLower, count: otherCount, complete: !otherLower, group: -1,
    })
  }
  if (pendingCount) {
    const known = items.reduce((s, i) => s + i.value, 0)
    items.push({
      key: `p:${dir}`, kind: 'pending', id: dir, label: `pending (${pendingCount.toLocaleString('en-US')})`,
      // a visible sliver whose size says nothing about the real contents
      value: known > 0 ? known * 0.03 : 1, files: 0, lower: true, count: pendingCount, complete: false, group: -1,
    })
  }
  items.sort((a, b) => b.value - a.value)
  return items
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

function squarify(values: number[], x: number, y: number, w: number, h: number): Rect[] {
  if (w <= 0 || h <= 0 || !values.length) return values.map(() => ({ x, y, w: 0, h: 0 }))
  type Datum = { v?: number; children?: { v: number }[] }
  const root = hierarchy<Datum>({ children: values.map((v) => ({ v })) }).sum((d) => d.v ?? 0)
  const laid = treemap<Datum>().tile(treemapSquarify).size([w, h]).paddingInner(0)(root)
  return (laid.children ?? []).map((l) => ({ x: x + l.x0, y: y + l.y0, w: l.x1 - l.x0, h: l.y1 - l.y0 }))
}

function toTile(item: Item, level: 1 | 2, parent: number, r: Rect, strip = false): Tile {
  return {
    key: item.key, kind: item.kind, level, id: item.id, parent, group: item.group, label: item.label,
    bytes: item.value, files: item.files, lower: item.lower, count: item.count, complete: item.complete,
    strip, x: r.x, y: r.y, w: r.w, h: r.h,
  }
}

export function layoutTreemap(tree: Tree, dir: number, width: number, height: number): Layout {
  const total = tree.totalBytes[dir]
  if (dir < 0 || dir >= tree.n || width <= 0 || height <= 0) return { tiles: [], total: 0 }

  const level1 = gather(tree, dir, MAX_LEVEL1, 1, -1)
  if (!level1.length) return { tiles: [], total }

  // level-2 budget: shared out by size, so big tiles get the detail
  const sum = level1.reduce((s, i) => s + i.value, 0)
  const budget = Math.max(0, MAX_TILES - level1.length)
  const rects = squarify(level1.map((i) => i.value), 0, 0, width, height)

  const tiles: Tile[] = level1.map((item, i) => toTile(item, 1, -1, rects[i]))
  const nested: Tile[] = []
  level1.forEach((item, i) => {
    if (item.kind !== 'dir') return
    const r = rects[i]
    const strip = r.w >= MIN_NESTED_W && r.h >= MIN_NESTED_H
    const inner: Rect = {
      x: r.x + 1, y: r.y + 1 + (strip ? LABEL_STRIP : 0),
      w: r.w - 2, h: r.h - 2 - (strip ? LABEL_STRIP : 0),
    }
    if (inner.w < MIN_CHILD_AREA || inner.h < MIN_CHILD_AREA) return
    const allowed = Math.floor((budget * item.value) / sum)
    if (allowed < 2) return
    const kids = gather(tree, item.id, Math.min(allowed, 60), 2, item.group)
    if (!kids.length) return
    const kr = squarify(kids.map((k) => k.value), inner.x, inner.y, inner.w, inner.h)
    tiles[i].strip = strip
    kids.forEach((k, j) => nested.push(toTile(k, 2, item.id, kr[j])))
  })
  return { tiles: tiles.concat(nested), total }
}

/** 0 (tiny) … 4 (huge): how much of the current dir a tile holds, on a roughly log scale. */
export function sizeClass(bytes: number, dirTotal: number): number {
  if (dirTotal <= 0) return 0
  const f = bytes / dirTotal
  return f >= 0.25 ? 4 : f >= 0.08 ? 3 : f >= 0.02 ? 2 : f >= 0.005 ? 1 : 0
}
