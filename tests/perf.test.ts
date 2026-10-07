// Performance targets from the spec, checked on a synthetic 1M-dir snapshot:
//   - parse + index in under 2 s
//   - interactions under 50 ms
//   - live ingestion of 10k events/s (covered in scanStore.test.ts)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { generateSnapshotJSON } from '../scripts/synthetic.mjs'
import { applyEvents, createLiveState } from '@/lib/events'
import { buildSnapshot, type ScanData } from '@/lib/snapshot'
import { searchDirs } from '@/lib/search'
import { layoutTreemap, MAX_TILES } from '@/lib/treemap'
import { makeSubtreeTester, pathOf } from '@/lib/tree'

const N = 1_000_000
const LOAD_BUDGET_MS = 2000
const INTERACTION_BUDGET_MS = 50

let text: string
let snap: ScanData
let loadMs = 0
const timings: Record<string, number> = {}

/** best of a few runs, so a GC pause doesn't fail the build */
function time<T>(name: string, fn: () => T, runs = 5): T {
  let best = Infinity
  let out!: T
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    out = fn()
    best = Math.min(best, performance.now() - t)
  }
  timings[name] = best
  return out
}

describe(`${N.toLocaleString('en-US')}-dir snapshot`, () => {
  beforeAll(() => {
    text = generateSnapshotJSON({ dirs: N, seed: 1 })
    // measured the way the viewer does it: JSON text -> parsed -> columnar tree
    let best = Infinity
    for (let i = 0; i < 3; i++) {
      const t = performance.now()
      snap = buildSnapshot(JSON.parse(text))
      best = Math.min(best, performance.now() - t)
    }
    loadMs = best
  }, 120_000)

  it('parses and indexes in under 2 s', () => {
    expect(snap.tree.n).toBe(N)
    expect(snap.tree.totalBytes[0]).toBe(snap.meta.totals!.bytes)
    timings.load = loadMs
    expect(loadMs).toBeLessThan(LOAD_BUDGET_MS)
  })

  it('keeps the tree in typed arrays, with children lists built', () => {
    const t = snap.tree
    expect(t.parent).toBeInstanceOf(Int32Array)
    expect(t.totalBytes).toBeInstanceOf(Float64Array)
    let kids = 0
    for (let i = 0; i < t.n; i += 997) kids += t.childCount(i)
    expect(kids).toBeGreaterThan(0)
  })

  it('lays out the treemap of the root (huge fan-out) in under 50 ms', () => {
    const { tiles } = time('treemap(root)', () => layoutTreemap(snap.tree, 0, 1400, 800))
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles.length).toBeLessThanOrEqual(MAX_TILES)
    expect(timings['treemap(root)']).toBeLessThan(INTERACTION_BUDGET_MS)
  })

  it('lays out a deep dir and the busiest dir in under 50 ms', () => {
    const t = snap.tree
    let busiest = 0
    let most = 0
    for (let i = 0; i < t.n; i += 13) {
      const c = t.childCount(i)
      if (c > most) [most, busiest] = [c, i]
    }
    expect(most).toBeGreaterThan(20)
    time('treemap(busiest)', () => layoutTreemap(t, busiest, 1400, 800))
    expect(timings['treemap(busiest)']).toBeLessThan(INTERACTION_BUDGET_MS)
  })

  it('lists and sorts the children of the root (Subdirs table rows) in under 50 ms', () => {
    const t = snap.tree
    const rows = time('children(root)+sort', () =>
      t.children(0).map((id) => ({ id, bytes: t.totalBytes[id] })).sort((a, b) => b.bytes - a.bytes),
    )
    expect(rows.length).toBeGreaterThan(30)
    expect(timings['children(root)+sort']).toBeLessThan(INTERACTION_BUDGET_MS)
  })

  it('the first search of a tree (builds the lowercase name column once) stays under half a second', () => {
    const t = performance.now()
    expect(searchDirs(snap.tree, 'd1a', 200).length).toBeGreaterThan(0)
    timings['search cold (1st)'] = performance.now() - t
    expect(timings['search cold (1st)']).toBeLessThan(500)
  })

  it('searches all names in under 50 ms per keystroke (≥ 3 chars, bounded results)', () => {
    const hits = time('search("d1a")', () => searchDirs(snap.tree, 'd1a', 200))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThanOrEqual(200)
    expect(timings['search("d1a")']).toBeLessThan(INTERACTION_BUDGET_MS)
  })

  it('searches a path query with an ancestor token', () => {
    time('search("d1 d2a")', () => searchDirs(snap.tree, 'd1 d2a', 200))
    expect(timings['search("d1 d2a")']).toBeLessThan(INTERACTION_BUDGET_MS)
  })

  it('builds paths and tests subtree membership of 1,000 dirs in under 50 ms', () => {
    const t = snap.tree
    const ids = Array.from({ length: 1000 }, (_, i) => (i * 997) % t.n)
    time('pathOf x1000', () => ids.map((id) => pathOf(t, snap.meta.root, id)))
    expect(timings['pathOf x1000']).toBeLessThan(INTERACTION_BUDGET_MS)
    const inside = makeSubtreeTester(t, 1)
    time('subtree x1000', () => ids.map((id) => inside(id)), 3)
    expect(timings['subtree x1000']).toBeLessThan(INTERACTION_BUDGET_MS)
  })

  it('applies live events for a 1M-dir scan incrementally (O(depth) per event)', () => {
    // replay the same tree through the reducer: n events then s events, as the scanner emits them
    const t = snap.tree
    const evs: unknown[][] = [['n', 0, -1, t.names[0]]]
    for (let i = 1; i < t.n; i++) evs.push(['n', i, t.parent[i], t.names[i]])
    for (let i = 0; i < t.n; i++) evs.push(['s', i, t.ownBytes[i], t.ownFiles[i], t.flags[i]])
    const st = createLiveState()
    const t0 = performance.now()
    applyEvents(st, evs)
    timings.reducer1M = performance.now() - t0
    expect(st.tree.totalBytes[0]).toBe(t.totalBytes[0])
    expect(st.tree.isComplete(0)).toBe(true)
    // 2M events; far above the 10k events/s the UI needs
    expect(evs.length / (timings.reducer1M / 1000)).toBeGreaterThan(100_000)
  })

  it('reports the numbers', () => {
    const lines = Object.entries(timings).map(([k, v]) => `${k.padEnd(22)} ${v.toFixed(1)} ms`)
    const report = `1M-dir performance (best of runs, ${os.cpus()[0]?.model ?? 'cpu'}):\n${lines.join('\n')}\n`
    fs.writeFileSync(path.join(os.tmpdir(), 'dirscan-view-perf.txt'), report)
    expect(lines.length).toBeGreaterThan(5)
  })
})
