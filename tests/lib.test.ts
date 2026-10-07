import { describe, expect, it } from 'vitest'
import { ApiError, initToken, getToken } from '@/lib/api'
import { applyEvents, createLiveState } from '@/lib/events'
import {
  formatAge, formatBytes, formatClock, formatCount, formatDateTime, formatDuration, formatMode, formatPercent, formatSize,
} from '@/lib/format'
import { buildHash, DEFAULT_ROUTE, parseHash } from '@/lib/route'
import { parseQuery, searchDirs } from '@/lib/search'
import { SseParser } from '@/lib/sse'
import { LABEL_STRIP, layoutTreemap, MAX_TILES, sizeClass, type Tile } from '@/lib/treemap'
import { Tree } from '@/lib/tree'
import { loadFixtures, mulberry32 } from './fixtures'

const fixtures = loadFixtures()
const big = fixtures.find((f) => f.name === 'big')!
const small = fixtures.find((f) => f.name === 'small')!

describe('format', () => {
  it('formats bytes like dirscan.py (1024-based)', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5403)).toBe('5.3 KB')
    expect(formatBytes(1024 ** 3 * 3.2)).toBe('3.2 GB')
    expect(formatBytes(1024 ** 4 * 150)).toBe('150 TB')
    expect(formatBytes(NaN)).toBe('–')
  })
  it('marks lower bounds with ≥', () => {
    expect(formatSize(2048, true)).toBe('≥ 2.0 KB')
    expect(formatSize(2048, false)).toBe('2.0 KB')
  })
  it('formats counts, percents, ages, durations, times', () => {
    expect(formatCount(1234567)).toBe('1,234,567')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.0004)).toBe('<0.1%')
    expect(formatPercent(0.0567)).toBe('5.7%')
    expect(formatPercent(0.5)).toBe('50%')
    expect(formatPercent(1)).toBe('100%')
    const now = 1_000_000_000_000
    expect(formatAge(now / 1000 - 5, now)).toBe('5s ago')
    expect(formatAge(now / 1000 - 125, now)).toBe('2m ago')
    expect(formatAge(now / 1000 - 7300, now)).toBe('2h ago')
    expect(formatAge(now / 1000 - 3 * 86400, now)).toBe('3d ago')
    expect(formatAge(now / 1000 + 50, now)).toBe('0s ago')
    expect(formatDuration(0.25)).toBe('250ms')
    expect(formatDuration(12.34)).toBe('12.3s')
    expect(formatDuration(245)).toBe('4m 05s')
    expect(formatDuration(7380)).toBe('2h 03m')
    expect(formatDateTime(0)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/)
    expect(formatClock(0)).toMatch(/^\d\d:\d\d:\d\d$/)
    expect(formatMode(0o100644)).toBe('-rw-r--r--')
    expect(formatMode(0o040755)).toBe('drwxr-xr-x')
    expect(formatMode(0o120777)).toBe('lrwxrwxrwx')
  })
})

describe('route (view state in the URL hash)', () => {
  it('round-trips a full route', () => {
    const r = { scan: '/home/u/.cache/dirscan/x-apparent-1.json', dir: 42, tab: 'files', color: 'size', scope: 'global' } as const
    expect(parseHash(buildHash(r))).toEqual(r)
  })
  it('omits defaults and treats unknown / empty hashes as the dashboard', () => {
    expect(buildHash({ ...DEFAULT_ROUTE, scan: '/a b/c.json' })).toBe('#/scan?file=%2Fa+b%2Fc.json')
    for (const h of ['', '#', '#/', '#/nope', '#/scan', '#/scan?dir=3']) expect(parseHash(h)).toEqual(DEFAULT_ROUTE)
  })
  it('sanitises bad numbers and enum values', () => {
    expect(parseHash('#/scan?file=f&dir=-3&tab=bogus&color=x&scope=y')).toEqual({ ...DEFAULT_ROUTE, scan: 'f' })
    expect(parseHash('#/scan?file=f&dir=1.5').dir).toBe(0)
    expect(parseHash('#/scan?file=f&dir=abc').dir).toBe(0)
  })
  it('survives odd characters in the file key', () => {
    const scan = '/tmp/a&b=c#d?e %20.json'
    expect(parseHash(buildHash({ ...DEFAULT_ROUTE, scan })).scan).toBe(scan)
  })
})

describe('SseParser', () => {
  it('parses messages split at arbitrary points', () => {
    const text = ': connected\n\ndata: [1,2]\n\nevent: closed\ndata: {"state":"abandoned"}\n\n: keepalive\n\ndata: a\ndata: b\n\n'
    const whole = new SseParser().push(text)
    expect(whole).toEqual([
      { event: 'message', data: '[1,2]' },
      { event: 'closed', data: '{"state":"abandoned"}' },
      { event: 'message', data: 'a\nb' },
    ])
    for (let seed = 1; seed < 30; seed++) {
      const rnd = mulberry32(seed)
      const p = new SseParser()
      const got = []
      for (let i = 0; i < text.length; ) {
        const n = 1 + Math.floor(rnd() * 9)
        got.push(...p.push(text.slice(i, i + n)))
        i += n
      }
      expect(got).toEqual(whole)
    }
  })
  it('handles CRLF line endings and a lone CR', () => {
    expect(new SseParser().push('data: x\r\n\r\ndata: y\r\rdata: z\n\n')).toEqual([
      { event: 'message', data: 'x' },
      { event: 'message', data: 'y' },
      { event: 'message', data: 'z' },
    ])
    // a trailing CR might be the first half of CRLF, so it is held until the next byte
    const p = new SseParser()
    expect(p.push('data: w\r\r')).toEqual([])
    expect(p.push('x')).toEqual([{ event: 'message', data: 'w' }])
  })
  it('does not emit a message until its blank line arrives', () => {
    const p = new SseParser()
    expect(p.push('data: [1]\n')).toEqual([])
    expect(p.push('\n')).toEqual([{ event: 'message', data: '[1]' }])
  })
})

describe('token handling', () => {
  const mk = (url: string) => {
    const u = new URL(url)
    const calls: string[] = []
    return {
      loc: { search: u.search, pathname: u.pathname, hash: u.hash } as Location,
      hist: { replaceState: (_s: unknown, _t: string, to: string) => calls.push(to) } as unknown as History,
      calls,
    }
  }
  it('reads the token from the URL once and strips it, keeping the hash and other params', () => {
    const { loc, hist, calls } = mk('http://127.0.0.1:4173/?token=abc123&x=1#/scan?file=f')
    expect(initToken(loc, hist)).toBe('abc123')
    expect(getToken()).toBe('abc123')
    expect(calls).toEqual(['/?x=1#/scan?file=f'])
  })
  it('ApiError carries status and code', () => {
    const e = new ApiError(403, 'EOUTSIDE', 'nope')
    expect([e.status, e.code, e.message]).toEqual([403, 'EOUTSIDE', 'nope'])
  })
})

describe('search', () => {
  it('splits the query on whitespace and slashes', () => {
    expect(parseQuery(' Genbo/ckpt  Final ')).toEqual(['genbo', 'ckpt', 'final'])
  })

  const tree = small.snapshot.tree
  it('ranks exact > prefix > substring > subsequence, and finds nothing for nonsense', () => {
    const t = new Tree()
    ;['root', 'src', 'srcfoo', 'my-src', 'xsrcx', 'sxrxc'].forEach((n, i) => t.addDir(i, i ? 0 : -1, n))
    const names = searchDirs(t, 'src').map((h) => t.names[h.id])
    expect(names).toEqual(['src', 'srcfoo', 'my-src', 'xsrcx', 'sxrxc'])
    expect(searchDirs(t, 'zzzz')).toEqual([])
    expect(searchDirs(t, '')).toEqual([])
    expect(searchDirs(t, '  /  ')).toEqual([])
  })
  it('is case-insensitive', () => {
    const hits = searchDirs(tree, 'DIR WITH SPACE')
    expect(hits.length).toBeGreaterThan(0)
    for (const h of hits) expect(tree.names[h.id].toLowerCase()).toContain('space')
    expect(searchDirs(tree, 'dir with space').map((h) => h.id)).toEqual(searchDirs(tree, 'Dir With Space').map((h) => h.id))
  })
  it('matches path prefixes: earlier tokens must appear among the ancestors, in order', () => {
    const t = new Tree()
    const add = (parent: number, name: string) => {
      t.addDir(t.n, parent, name)
      return t.n - 1
    }
    const root = add(-1, 'root')
    const genbo = add(root, 'genbo')
    const other = add(root, 'other')
    const a = add(genbo, 'ckpt')
    const b = add(other, 'ckpt')
    const deep = add(add(genbo, 'runs'), 'ckpt')
    const ids = (q: string) => searchDirs(t, q).map((h) => h.id).sort((x, y) => x - y)
    expect(ids('ckpt')).toEqual([a, b, deep].sort((x, y) => x - y))
    expect(ids('genbo ckpt')).toEqual([a, deep].sort((x, y) => x - y))
    expect(ids('genbo/ckpt')).toEqual([a, deep].sort((x, y) => x - y))
    expect(ids('other/ckpt')).toEqual([b])
    expect(ids('runs genbo ckpt')).toEqual([]) // wrong order: genbo is above runs
    expect(ids('genbo runs ckpt')).toEqual([deep])
  })
  it('finds a lone dir whose name contains spaces, from any subset of its words', () => {
    const t = new Tree()
    t.addDir(0, -1, 'root')
    t.addDir(1, 0, 'My Project Files')
    t.addDir(2, 0, 'unrelated')
    for (const q of ['my project files', 'project files', 'my files', 'files', 'My Project']) {
      expect(searchDirs(t, q).map((h) => h.id), q).toEqual([1])
    }
  })
  it('breaks ties by size and returns at most `limit`', () => {
    const hits = searchDirs(big.snapshot.tree, 'd', 7)
    expect(hits).toHaveLength(7)
    const all = searchDirs(big.snapshot.tree, 'd', 200)
    expect(all).toHaveLength(200)
    for (let i = 1; i < all.length; i++) expect(all[i - 1].score).toBeGreaterThanOrEqual(all[i].score)
  })
  it('works on a tree that is still growing (live scan)', () => {
    const st = createLiveState()
    applyEvents(st, big.events.slice(0, 300))
    expect(st.tree.n).toBeGreaterThan(10)
    const target = st.tree.names[st.tree.n - 1]
    expect(searchDirs(st.tree, target).map((h) => st.tree.names[h.id])).toContain(target)
  })
})

function checkLayout(tiles: Tile[], W: number, H: number) {
  for (const t of tiles) {
    expect(t.w).toBeGreaterThanOrEqual(0)
    expect(t.h).toBeGreaterThanOrEqual(0)
    expect(t.x).toBeGreaterThanOrEqual(-1e-6)
    expect(t.y).toBeGreaterThanOrEqual(-1e-6)
    expect(t.x + t.w).toBeLessThanOrEqual(W + 1e-6)
    expect(t.y + t.h).toBeLessThanOrEqual(H + 1e-6)
  }
  expect(new Set(tiles.map((t) => t.key)).size).toBe(tiles.length) // keys are unique
}

const area = (t: Tile) => t.w * t.h

describe('treemap layout', () => {
  const W = 800
  const H = 500

  it('level-1 tile areas are proportional to bytes and tile the whole canvas', () => {
    const tree = small.snapshot.tree
    const { tiles, total } = layoutTreemap(tree, 0, W, H)
    expect(total).toBe(tree.totalBytes[0])
    const l1 = tiles.filter((t) => t.level === 1)
    checkLayout(tiles, W, H)
    const sum = l1.reduce((s, t) => s + t.bytes, 0)
    expect(l1.reduce((s, t) => s + area(t), 0)).toBeCloseTo(W * H, 3)
    for (const t of l1) expect(area(t) / (W * H)).toBeCloseTo(t.bytes / sum, 6)
  })

  it('every byte is accounted for: level-1 values sum to the dir total (complete scan)', () => {
    const tree = small.snapshot.tree
    for (const dir of [0, ...tree.children(0)]) {
      const { tiles } = layoutTreemap(tree, dir, W, H)
      const l1 = tiles.filter((t) => t.level === 1 && t.kind !== 'pending')
      expect(l1.reduce((s, t) => s + t.bytes, 0)).toBe(tree.totalBytes[dir])
    }
  })

  it('level-2 tiles sit inside their level-1 parent, below its label strip', () => {
    const tree = big.snapshot.tree
    const { tiles } = layoutTreemap(tree, 0, 1200, 700)
    const byId = new Map(tiles.filter((t) => t.level === 1 && t.kind === 'dir').map((t) => [t.id, t]))
    const l2 = tiles.filter((t) => t.level === 2)
    expect(l2.length).toBeGreaterThan(0)
    for (const t of l2) {
      const p = byId.get(t.parent)!
      expect(p).toBeDefined()
      expect(t.x).toBeGreaterThanOrEqual(p.x - 1e-6)
      expect(t.y).toBeGreaterThanOrEqual(p.y + (p.strip ? LABEL_STRIP : 0) - 1e-6)
      expect(t.x + t.w).toBeLessThanOrEqual(p.x + p.w + 1e-6)
      expect(t.y + t.h).toBeLessThanOrEqual(p.y + p.h + 1e-6)
      // colour follows the top-level ancestor; roll-up tiles are neutral
      expect(t.group).toBe(t.kind === 'other' || t.kind === 'pending' ? -1 : p.group)
    }
  })

  it('caps the tile count and rolls the rest into "other (N)" without losing bytes', () => {
    const t = new Tree()
    t.addDir(0, -1, 'wide')
    const N = 5000
    let total = 0
    for (let i = 1; i <= N; i++) {
      t.addDir(i, 0, `d${i}`)
      t.totalBytes[i] = i
      t.totalFiles[i] = 1
      t.flags[i] = 6
      total += i
    }
    t.totalBytes[0] = total
    t.flags[0] = 6
    const { tiles } = layoutTreemap(t, 0, 1000, 600)
    expect(tiles.length).toBeLessThanOrEqual(MAX_TILES)
    const other = tiles.find((x) => x.kind === 'other')!
    expect(other).toBeDefined()
    expect(other.count).toBeGreaterThan(4000)
    expect(tiles.reduce((s, x) => s + (x.level === 1 ? x.bytes : 0), 0)).toBe(total)
    // the largest dirs are the ones kept
    expect(tiles.some((x) => x.kind === 'dir' && x.label === `d${N}`)).toBe(true)
    expect(tiles.some((x) => x.kind === 'dir' && x.label === 'd1')).toBe(false)
    checkLayout(tiles, 1000, 600)
  })

  it('shows the dir\'s own files as a single "(files)" tile', () => {
    const tree = small.snapshot.tree
    const withFiles = [...Array(tree.n).keys()].find((i) => tree.ownBytes[i] > 0 && tree.firstChild[i] !== -1)!
    const { tiles } = layoutTreemap(tree, withFiles, W, H)
    const files = tiles.filter((t) => t.kind === 'files' && t.level === 1)
    expect(files).toHaveLength(1)
    expect(files[0].bytes).toBe(tree.ownBytes[withFiles])
    expect(files[0].label).toBe('(files)')
  })

  it('shows unscanned dirs as one "pending" tile, and incomplete ones with lower bounds', () => {
    // a live scan caught half way
    const st = createLiveState()
    const half = (): boolean => {
      const t = st.tree
      return t.children(0).some((c) => t.totalBytes[c] > 0 && !t.isComplete(c)) && t.children(0).some((c) => !t.isVisited(c))
    }
    for (const ev of big.events) {
      applyEvents(st, [ev])
      if (half()) break
    }
    expect(half()).toBe(true) // a top-level dir is part-way through, others untouched
    const { tiles } = layoutTreemap(st.tree, 0, W, H)
    expect(st.tree.isComplete(0)).toBe(false)
    const dirs = tiles.filter((t) => t.kind === 'dir' && t.level === 1)
    expect(dirs.some((t) => t.lower)).toBe(true)
    expect(dirs.every((t) => t.lower === !t.complete)).toBe(true)
    const pending = tiles.filter((t) => t.kind === 'pending' && t.level === 1)
    expect(pending).toHaveLength(1)
    expect(pending[0].lower).toBe(true)
    checkLayout(tiles, W, H)
  })

  it('at the very start of a scan (nothing scanned) the pending tile fills the canvas', () => {
    const st = createLiveState()
    applyEvents(st, [
      ['n', 0, -1, 'r'],
      ['n', 1, 0, 'a'],
      ['n', 2, 0, 'b'],
    ])
    const { tiles } = layoutTreemap(st.tree, 0, W, H)
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toMatchObject({ kind: 'pending', count: 2, lower: true })
    expect(area(tiles[0])).toBeCloseTo(W * H, 3)
  })

  it('empty dirs, unknown dirs and degenerate sizes produce no tiles', () => {
    const tree = small.snapshot.tree
    expect(layoutTreemap(tree, 0, 0, 100).tiles).toEqual([])
    expect(layoutTreemap(tree, 999999, 100, 100).tiles).toEqual([])
    const leaf = [...Array(tree.n).keys()].find((i) => tree.firstChild[i] === -1 && tree.totalBytes[i] === 0)!
    expect(layoutTreemap(tree, leaf, 100, 100).tiles).toEqual([])
  })

  it('colour groups follow discovery order and stay put when siblings are added', () => {
    const st = createLiveState()
    applyEvents(st, [['n', 0, -1, 'r'], ['n', 1, 0, 'a'], ['n', 2, 0, 'b'], ['s', 1, 100, 1, 2], ['s', 2, 50, 1, 2]])
    const g1 = Object.fromEntries(layoutTreemap(st.tree, 0, W, H).tiles.map((t) => [t.label, t.group]))
    applyEvents(st, [['n', 3, 0, 'c'], ['s', 3, 10, 1, 2]])
    const g2 = Object.fromEntries(layoutTreemap(st.tree, 0, W, H).tiles.map((t) => [t.label, t.group]))
    expect(g1.a).toBe(0)
    expect(g1.b).toBe(1)
    expect(g2.a).toBe(0)
    expect(g2.b).toBe(1)
    expect(g2.c).toBe(2)
  })

  it('size classes grow with the share of the dir', () => {
    expect([0.3, 0.1, 0.03, 0.01, 0.001].map((f) => sizeClass(f * 1000, 1000))).toEqual([4, 3, 2, 1, 0])
    expect(sizeClass(5, 0)).toBe(0)
  })
})
