import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyEvents, createLiveState, type LiveEvent } from '@/lib/events'
import { parseSnapshot } from '@/lib/snapshot'
import { F_COMPLETE, F_UNREADABLE, F_VISITED, pathOf } from '@/lib/tree'
import { findGdu } from '../scanner/gdu-bin.js'
import { planChunks } from '../scanner/plan.js'
import { ScanState } from '../scanner/state.js'
import { mulberry32 } from './fixtures'
import { REPO_ROOT } from '../server/start.js'
import { sleep, tmpDir } from './server-helpers'

const GDU = findGdu()
const SCANNER = path.join(REPO_ROOT, 'scanner', 'gduscan.js')
const PY = path.join(REPO_ROOT, 'dirscan.py')
const isRoot = process.getuid?.() === 0

type Snap = any

/** Run the gdu-based scanner synchronously; returns the snapshot it wrote. */
function gduscan(root: string, cache: string, extra: string[] = []) {
  const r = spawnSync(process.execPath, [SCANNER, root, '--rescan', '-q', '--cache-dir', cache, ...extra], { encoding: 'utf8' })
  return { ...r, ...readCache(cache, root, extra.includes('--du') ? 'du' : 'apparent') }
}
function pyscan(root: string, cache: string, extra: string[] = []) {
  const r = spawnSync('python3', [PY, root, '--rescan', '-q', '--cache-dir', cache, ...extra], { encoding: 'utf8' })
  return { ...r, ...readCache(cache, root, extra.includes('--du') ? 'du' : 'apparent') }
}
function readCache(cache: string, root: string, mode: string) {
  const idx = JSON.parse(fs.readFileSync(path.join(cache, 'index.json'), 'utf8'))
  const key = Object.keys(idx).find((k) => idx[k].root === root && idx[k].mode === mode)!
  return {
    key,
    snap: JSON.parse(fs.readFileSync(key, 'utf8')) as Snap,
    events: fs.readFileSync(key.replace(/\.json$/, '.events.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) as LiveEvent[],
  }
}

/** dir path -> row, so snapshots with different dir orderings can be compared */
function byPath(s: Snap) {
  const p: string[] = []
  const m = new Map<string, any[]>()
  s.dirs.forEach((r: any[], i: number) => {
    p[i] = r[0] < 0 ? '' : p[r[0]] + '/' + r[1]
    m.set(p[i], r)
  })
  return m
}

/** Everything that must agree between the two engines; returns the differences found. */
function diff(a: Snap, b: Snap): string[] {
  const out: string[] = []
  const A = byPath(a)
  const B = byPath(b)
  if (A.size !== B.size) out.push(`dir count ${A.size} vs ${B.size}`)
  for (const [p, r] of A) {
    const q = B.get(p)
    if (!q) { out.push(`missing: ${p}`); continue }
    for (let i = 2; i < 7; i++) if (r[i] !== q[i]) { out.push(`${p} ${a.dir_fields[i]}: ${r[i]} vs ${q[i]}`); break }
  }
  for (const k of ['bytes', 'files', 'dirs', 'errors']) if (a.totals[k] !== b.totals[k]) out.push(`totals.${k}: ${a.totals[k]} vs ${b.totals[k]}`)
  if (JSON.stringify(Object.entries(a.extensions).sort()) !== JSON.stringify(Object.entries(b.extensions).sort())) out.push('extensions differ')
  if (a.largest_files.map((x: any[]) => x[2]).join() !== b.largest_files.map((x: any[]) => x[2]).join()) out.push('largest file sizes differ')
  return out
}

/** A tree with the things that make scanners disagree. */
function buildTree(root: string, seed = 1, dirs = 60) {
  const rnd = mulberry32(seed)
  fs.mkdirSync(root, { recursive: true })
  const all = [root]
  const names = ['plain', 'with space', 'dot.dir', '.hidden', 'ünïcode-日本', 'we"ird]},name', "quote'd", 'a,b', '-dash', 'tilde~']
  for (let i = 0; i < dirs; i++) {
    const parent = all[Math.floor(rnd() * all.length)]
    const d = path.join(parent, `${names[i % names.length]}${i}`)
    fs.mkdirSync(d)
    all.push(d)
  }
  fs.mkdirSync(path.join(root, 'empty-dir'))
  let n = 0
  for (const d of all) {
    for (let j = 0, k = Math.floor(rnd() * 8); j < k; j++, n++) {
      const ext = ['.py', '.PT', '.tar.gz', '', '.log', '.', '.JSON'][Math.floor(rnd() * 7)]
      const p = path.join(d, `f${n}${ext}`)
      const size = [0, 0, 1, 100, 4096, 70_000, 3_000_000][Math.floor(rnd() * 7)]
      fs.writeFileSync(p, size && size < 100_000 ? Buffer.alloc(size, 120) : '')
      if (size >= 100_000) fs.truncateSync(p, size) // sparse: apparent size vs disk usage differ
    }
  }
  fs.writeFileSync(path.join(root, '.bashrc'), 'x')
  fs.writeFileSync(path.join(root, '..double'), 'xx')
  // things neither engine counts, or both count once per link
  fs.symlinkSync(all[1], path.join(root, 'link-to-dir'))
  fs.symlinkSync('f0', path.join(root, 'link-to-file'))
  fs.symlinkSync('/nonexistent', path.join(root, 'dangling'))
  fs.writeFileSync(path.join(root, 'orig'), 'hardlinked')
  fs.linkSync(path.join(root, 'orig'), path.join(all[1], 'hard1'))
  fs.linkSync(path.join(root, 'orig'), path.join(all[2], 'hard2'))
  return all
}

describe.skipIf(!GDU)('gduscan matches dirscan.py', () => {
  for (const mode of ['apparent', 'du'] as const) {
    it(`${mode}: every directory, total, extension and large file is identical`, () => {
      const root = path.join(tmpDir('gs-tree-'), 'proj')
      buildTree(root)
      const flag = mode === 'du' ? ['--du'] : []
      const py = pyscan(root, tmpDir('gs-pc-'), flag)
      const gs = gduscan(root, tmpDir('gs-gc-'), flag)
      expect(gs.status, gs.stderr).toBe(0)
      expect(diff(py.snap, gs.snap)).toEqual([])
      expect(gs.snap.complete).toBe(true)
      expect(gs.snap.mode).toBe(mode)
      expect(gs.snap.dirs.length).toBeGreaterThan(50)
    })
  }

  it('writes the same snapshot key as dirscan.py, so either engine replaces the other\'s scan', () => {
    const root = path.join(tmpDir('gs-tree-'), 'same-key')
    buildTree(root, 2, 10)
    const py = pyscan(root, tmpDir('gs-pc-'))
    const gs = gduscan(root, tmpDir('gs-gc-'))
    expect(path.basename(gs.key)).toBe(path.basename(py.key))
  })

  it('writes every field of the format, plus which engine produced it', () => {
    const root = path.join(tmpDir('gs-tree-'), 'fields')
    buildTree(root, 3, 8)
    const { snap } = gduscan(root, tmpDir('gs-gc-'))
    expect(Object.keys(snap)).toEqual(expect.arrayContaining(['version', 'root', 'host', 'mode', 'scanned_at', 'started_epoch', 'scanned_epoch', 'duration_s', 'complete', 'totals', 'dir_fields', 'flags', 'dirs', 'file_fields', 'largest_files', 'extensions']))
    expect(snap.version).toBe(2)
    expect(snap.dir_fields).toEqual(['parent', 'name', 'own_bytes', 'own_files', 'total_bytes', 'total_files', 'flags'])
    expect(snap.flags).toEqual({ unreadable: 1, visited: 2, complete: 4 })
    expect(snap.scanned_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/)
    expect(snap.engine.name).toBe('gdu')
    expect(snap.dirs[0][0]).toBe(-1)
    snap.dirs.forEach((r: any[], i: number) => i && expect(r[0]).toBeLessThan(i)) // parents come first
  })

  it('the chunking never changes the answer (split deep, shallow, or hand whole dirs to gdu)', () => {
    const root = path.join(tmpDir('gs-tree-'), 'chunks')
    buildTree(root, 4, 120)
    const base = gduscan(root, tmpDir('gs-gc-')).snap
    for (const extra of [
      ['--min-chunks', '1'],
      ['--min-chunks', '100000'],
      ['--max-entries', '3'], // root too big to read here: gdu scans it whole
      ['--max-subdirs', '2'],
      ['--chunk-parallel', '1'],
      ['--chunk-parallel', '8'],
    ]) {
      const r = gduscan(root, tmpDir('gs-gc-'), extra)
      expect(r.status, extra.join(' ')).toBe(0)
      expect(diff(base, r.snap), extra.join(' ')).toEqual([])
    }
  })

  it('a fresh cached scan is shown without rescanning; --rescan scans again', () => {
    const root = path.join(tmpDir('gs-tree-'), 'cached')
    buildTree(root, 5, 5)
    const cache = tmpDir('gs-gc-')
    const first = gduscan(root, cache)
    const again = spawnSync(process.execPath, [SCANNER, root, '--cache-dir', cache], { encoding: 'utf8' })
    expect(again.stdout).toMatch(/Cached scan/)
    expect(JSON.parse(fs.readFileSync(first.key, 'utf8')).scanned_at).toBe(first.snap.scanned_at)
  })

  it('fails clearly on a bad root, and on an explicit gdu path that does not exist (it must not quietly use another)', () => {
    const bad = spawnSync(process.execPath, [SCANNER, '/definitely/not/here', '-q'], { encoding: 'utf8' })
    expect(bad.status).toBe(2)
    expect(bad.stderr).toMatch(/not a directory/)
    expect(findGdu('/no/such/gdu')).toBeNull()
    const nogdu = spawnSync(process.execPath, [SCANNER, tmpDir(), '-q', '--gdu', '/no/such/gdu'], { encoding: 'utf8' })
    expect(nogdu.status).toBe(2)
    expect(nogdu.stderr).toMatch(/gdu not found/)
  })

  it.skipIf(isRoot)('unreadable directories are flagged and counted, like dirscan.py', () => {
    const root = path.join(tmpDir('gs-tree-'), 'locked')
    buildTree(root, 6, 10)
    const locked = path.join(root, 'locked-dir')
    fs.mkdirSync(path.join(locked, 'inner'), { recursive: true })
    fs.writeFileSync(path.join(locked, 'secret'), 'x')
    fs.chmodSync(locked, 0)
    try {
      const py = pyscan(root, tmpDir('gs-pc-'))
      const gs = gduscan(root, tmpDir('gs-gc-'))
      expect(diff(py.snap, gs.snap)).toEqual([])
      const row = byPath(gs.snap).get('/locked-dir')!
      expect(row[6] & F_UNREADABLE).toBe(F_UNREADABLE)
      expect(gs.snap.totals.errors).toBe(py.snap.totals.errors)
      expect(gs.snap.totals.errors).toBeGreaterThan(0)
    } finally {
      fs.chmodSync(locked, 0o755)
    }
  })

  it('known difference: gdu does not mark fifos, so inside a directory gdu scans they count as empty files (sockets and symlinks are skipped)', () => {
    const root = path.join(tmpDir('gs-tree-'), 'fifo')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, 'real'), 'x')
    spawnSync('mkfifo', [path.join(root, 'pipe')])
    if (!fs.existsSync(path.join(root, 'pipe'))) return
    const py = pyscan(root, tmpDir('gs-pc-'))
    expect(py.snap.totals.files).toBe(1)
    // a directory the planner reads itself is exact...
    expect(gduscan(root, tmpDir('gs-gc-')).snap.totals.files).toBe(1)
    // ...one handed to gdu (here: forced by --max-entries 0) cannot tell a fifo from an empty file
    const viaGdu = gduscan(root, tmpDir('gs-gc-'), ['--max-entries', '0'])
    expect(viaGdu.snap.totals.files).toBe(2)
    expect(viaGdu.snap.totals.bytes).toBe(py.snap.totals.bytes) // sizes are unaffected
  })
})

describe.skipIf(!GDU)('gduscan event stream', () => {
  /** The reducer applied to the events must give the snapshot's tree, flags and totals exactly. */
  function expectEventsMatch(events: LiveEvent[], snap: Snap) {
    const st = createLiveState()
    applyEvents(st, events)
    const t = st.tree
    const s = parseSnapshot(JSON.stringify(snap)).tree
    expect(t.n).toBe(s.n)
    const MASK = F_UNREADABLE | F_VISITED | F_COMPLETE
    for (let i = 0; i < s.n; i++) {
      if (t.parent[i] !== s.parent[i] || t.names[i] !== s.names[i]) throw new Error(`dir ${i} structure differs`)
      if ((t.flags[i] & MASK) !== (s.flags[i] & MASK)) throw new Error(`dir ${i} ${s.names[i]} flags ${t.flags[i]} vs ${s.flags[i]}`)
      if (t.totalBytes[i] !== s.totalBytes[i] || t.totalFiles[i] !== s.totalFiles[i] || t.ownBytes[i] !== s.ownBytes[i]) {
        throw new Error(`dir ${i} ${pathOf(s, '', i)} totals differ`)
      }
    }
    expect(st.largest).toEqual(snap.largest_files)
    expect(st.extensions).toEqual(snap.extensions)
    expect(st.end?.complete).toBe(snap.complete)
    expect(st.end?.totals).toEqual(snap.totals)
    return st
  }

  it('complete scan: replaying the events gives exactly the snapshot', () => {
    const root = path.join(tmpDir('gs-tree-'), 'ev')
    buildTree(root, 7, 100)
    const r = gduscan(root, tmpDir('gs-gc-'))
    expect(r.events[0][0]).toBe('h')
    expect(r.events[r.events.length - 1][0]).toBe('e')
    expect((r.events[0][1] as any).pid).toBeGreaterThan(0)
    const st = expectEventsMatch(r.events, r.snap)
    expect(st.tree.isComplete(0)).toBe(true)
  })

  it('shows unscanned chunks as pending while others are done (what makes the live view fill in)', () => {
    const root = path.join(tmpDir('gs-tree-'), 'live')
    buildTree(root, 8, 150)
    const r = gduscan(root, tmpDir('gs-gc-'), ['--chunk-parallel', '1', '--min-chunks', '4'])
    const st = createLiveState()
    let sawPartial = false
    for (const ev of r.events) {
      applyEvents(st, [ev])
      const t = st.tree
      if (ev[0] === 's' && t.n > 20 && !t.isComplete(0) && t.children(0).some((c) => t.isComplete(c)) && t.children(0).some((c) => !t.isVisited(c))) sawPartial = true
    }
    expect(sawPartial).toBe(true) // some top-level dirs finished while others were still pending
  })

  it('a dir is announced (n) before it is finished (s), and every dir finishes exactly once', () => {
    const root = path.join(tmpDir('gs-tree-'), 'order')
    buildTree(root, 9, 80)
    const { events, snap } = gduscan(root, tmpDir('gs-gc-'))
    const seen = new Set<number>()
    const done = new Set<number>()
    for (const e of events) {
      if (e[0] === 'n') { expect(e[1]).toBe(seen.size); seen.add(e[1] as number); expect(e[2] as number).toBeLessThan(e[1] as number) }
      if (e[0] === 's') { expect(seen.has(e[1] as number)).toBe(true); expect(done.has(e[1] as number)).toBe(false); done.add(e[1] as number) }
    }
    expect(done.size).toBe(snap.dirs.length)
  })

  it('progress events carry running totals', () => {
    const root = path.join(tmpDir('gs-tree-'), 'prog')
    buildTree(root, 10, 40)
    const { events } = gduscan(root, tmpDir('gs-gc-'))
    const e = events.filter((x) => x[0] === 'e')[0][1] as any
    expect(e.totals.files).toBeGreaterThan(0)
    const ps = events.filter((x) => x[0] === 'p')
    for (const p of ps) expect(p).toHaveLength(7)
  })

  /**
   * Start a scan and SIGTERM it once `fraction` of the directories have finished, judged from its
   * own event file (a fixed delay would depend on how loaded the machine is).
   */
  async function interrupted(root: string, cache: string, totalDirs: number, fraction: number, signals = 1) {
    const proc = spawn(process.execPath, [SCANNER, root, '--rescan', '-q', '--cache-dir', cache, '--chunk-parallel', '1', '--min-chunks', '200'], { stdio: 'ignore' })
    const exited = new Promise((r) => proc.on('exit', r))
    const events = path.join(cache, `${path.basename(root)}-apparent-${crypto.createHash('sha1').update(`${root}\0apparent`).digest('hex').slice(0, 10)}.events.ndjson`)
    const finished = () => {
      try {
        const text = fs.readFileSync(events, 'utf8')
        return { s: (text.match(/\n\["s",/g) ?? []).length, ended: text.includes('\n["e",') }
      } catch {
        return { s: 0, ended: false }
      }
    }
    for (let i = 0; i < 1500; i++) {
      const f = finished()
      if (f.ended || f.s >= totalDirs * fraction) break
      await sleep(10)
    }
    for (let i = 0; i < signals; i++) {
      proc.kill('SIGTERM')
      await sleep(30)
    }
    await exited
    return readCache(cache, root, 'apparent')
  }

  it('SIGTERM mid-scan: a partial snapshot whose events match it EXACTLY (no in-flight directory gap), second signal ignored', async () => {
    const root = path.join(tmpDir('gs-tree-'), 'big')
    const all = buildTree(root, 11, 1500)
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d)
      if (fs.lstatSync(p).isDirectory()) for (let i = 0; i < 30; i++) fs.closeSync(fs.openSync(path.join(p, `x${i}`), 'w'))
    }
    const total = all.length + 1
    const got = await interrupted(root, tmpDir('gs-gc-'), total, 0.35, 2)
    const visited = got.snap.dirs.filter((r: any[]) => r[6] & F_VISITED).length
    expect(got.snap.complete).toBe(false)
    expect(visited).toBeGreaterThan(0)
    expect(visited).toBeLessThan(got.snap.dirs.length)
    const st = expectEventsMatch(got.events, got.snap)
    expect(st.tree.isComplete(0)).toBe(false)
    // the second SIGTERM did not corrupt anything: the index says it is finished, the file parses
    const idx = JSON.parse(fs.readFileSync(path.join(path.dirname(got.key), 'index.json'), 'utf8'))
    expect(idx[got.key].in_progress).toBe(false)
    expect(idx[got.key].complete).toBe(false)
    expect(fs.readdirSync(path.dirname(got.key)).filter((f) => f.includes('.tmp') || f.startsWith('.gduscan-'))).toEqual([])
  }, 60_000)
})

describe('chunk planning', () => {
  const run = async (build: (root: string) => void, opts: Record<string, unknown> = {}) => {
    const root = path.join(tmpDir('plan-'), 'r')
    fs.mkdirSync(root)
    build(root)
    const state = new ScanState({ rootName: 'r' })
    const events: unknown[][] = []
    const chunks = await planChunks({ root, state, emit: (...r: unknown[]) => events.push(r), du: false, ...opts })
    return { root, state, events, chunks, names: chunks.map((c) => path.relative(root, c.path)).sort() }
  }
  const mk = (root: string, ...p: string[]) => fs.mkdirSync(path.join(root, ...p), { recursive: true })

  it('a wide root is read once, its subdirectories become the chunks, its own files are counted', async () => {
    const { chunks, state, events, names } = await run((r) => {
      for (let i = 0; i < 30; i++) mk(r, `d${i}`)
      fs.writeFileSync(path.join(r, 'top.txt'), 'hello')
    }, { minChunks: 24 })
    expect(chunks).toHaveLength(30)
    expect(names[0]).toBe('d0')
    expect(state.isVisited(0)).toBe(true)
    expect([state.ownBytes[0], state.ownFiles[0]]).toEqual([5, 1])
    expect(chunks.every((c) => !state.isVisited(c.id))).toBe(true) // pending until gdu has scanned them
    expect(events.filter((e) => e[0] === 'n')).toHaveLength(30)
  })

  it('a narrow root is looked through one level further until there are enough pieces', async () => {
    const { names, state } = await run((r) => {
      for (const a of ['a', 'b', 'c']) for (let i = 0; i < 10; i++) mk(r, a, `s${i}`)
    }, { minChunks: 24 })
    expect(names).toHaveLength(30)
    expect(names[0]).toBe('a/s0')
    expect(state.isVisited(1) || state.dirCount > 30).toBe(true) // a, b, c were expanded (finished here)
  })

  it('stops looking after maxDepth levels', async () => {
    const { names } = await run((r) => mk(r, 'a', 'b', 'c', 'd', 'e'), { minChunks: 99, maxDepth: 3 })
    expect(names).toEqual(['a/b/c'])
  })

  it('a directory too big to read cheaply is handed to gdu whole', async () => {
    const big = await run((r) => {
      for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(r, `f${i}`), '')
      mk(r, 'sub')
    }, { maxEntries: 5 })
    expect(big.chunks.map((c) => c.id)).toEqual([0]) // the root itself
    expect(big.state.dirCount).toBe(1) // nothing was added here: gdu will report the subdirs
    const wide = await run((r) => {
      for (let i = 0; i < 6; i++) mk(r, `d${i}`)
    }, { maxSubdirs: 5 })
    expect(wide.chunks.map((c) => c.id)).toEqual([0])
  })

  it.skipIf(isRoot)('an unlistable directory is a finished, unreadable one, and counts as an error', async () => {
    const root = path.join(tmpDir('plan-'), 'r')
    fs.mkdirSync(path.join(root, 'locked'), { recursive: true })
    fs.mkdirSync(path.join(root, 'ok'))
    fs.chmodSync(path.join(root, 'locked'), 0)
    try {
      const state = new ScanState({ rootName: 'r' })
      const events: unknown[][] = []
      // minChunks high: the planner looks one level further, so it tries to list `locked`
      await planChunks({ root, state, emit: (...r: unknown[]) => events.push(r), du: false, minChunks: 100, maxDepth: 3 })
      const id = state.name.indexOf('locked')
      expect(state.flags[id] & (F_UNREADABLE | F_VISITED)).toBe(F_UNREADABLE | F_VISITED)
      expect(events).toContainEqual(['s', id, 0, 0, F_UNREADABLE | F_VISITED])
      expect(state.errors).toBe(1)
    } finally {
      fs.chmodSync(path.join(root, 'locked'), 0o755)
    }
  })

  it('stops promptly when asked', async () => {
    const { chunks } = await run((r) => {
      for (let i = 0; i < 30; i++) mk(r, `d${i}`)
    }, { stopped: () => true })
    expect(chunks).toEqual([])
  })

  it('counts regular files only, in the chosen size mode', async () => {
    const root = path.join(tmpDir('plan-'), 'r')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, 'a'), Buffer.alloc(1000))
    fs.symlinkSync('a', path.join(root, 'link'))
    const state = new ScanState({ rootName: 'r' })
    await planChunks({ root, state, emit: () => {}, du: false })
    expect([state.ownBytes[0], state.ownFiles[0]]).toEqual([1000, 1])
    const du = new ScanState({ rootName: 'r' })
    await planChunks({ root, state: du, emit: () => {}, du: true })
    expect(du.ownBytes[0] % 512).toBe(0) // blocks * 512
  })
})
