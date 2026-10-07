import { describe, expect, it } from 'vitest'
import { parseSnapshot } from '@/lib/snapshot'
import { ancestry, makeSubtreeTester, pathOf, Tree } from '@/lib/tree'
import { loadFixtures, mulberry32 } from './fixtures'

const fixtures = loadFixtures()
const big = fixtures.find((f) => f.name === 'big')!.snapshot
const small = fixtures.find((f) => f.name === 'small')!.snapshot

const tiny = () =>
  parseSnapshot(
    JSON.stringify({
      version: 2, root: '/abs/path', host: 'h', mode: 'apparent', complete: true,
      totals: { bytes: 5403, files: 4, dirs: 3, errors: 0 },
      dirs: [[-1, 'genbo', 3, 1, 5403, 4, 6], [0, 'a', 300, 1, 5300, 2, 6], [1, 'b', 5000, 1, 5000, 1, 6]],
      largest_files: [[2, 'x.pt', 5000, 1791359698]], extensions: { '.pt': { files: 1, bytes: 5000 } },
    }),
  )

describe('parseSnapshot', () => {
  it('reads the spec example into columns', () => {
    const s = tiny()
    expect(s.tree.n).toBe(3)
    expect(Array.from(s.tree.parent.subarray(0, 3))).toEqual([-1, 0, 1])
    expect(s.tree.names).toEqual(['genbo', 'a', 'b'])
    expect(s.tree.totalBytes[0]).toBe(5403)
    expect(s.tree.children(0)).toEqual([1])
    expect(s.tree.isComplete(0)).toBe(true)
    expect(s.largest[0]).toEqual([2, 'x.pt', 5000, 1791359698])
    expect(s.meta.mode).toBe('apparent')
  })

  it('rejects other format versions', () => {
    expect(() => parseSnapshot(JSON.stringify({ version: 3, dirs: [] }))).toThrow(/version/)
  })

  it('children lists contain every non-root dir exactly once', () => {
    const t = big.tree
    const seen = new Uint8Array(t.n)
    let count = 0
    for (let i = 0; i < t.n; i++) {
      for (const c of t.children(i)) {
        expect(t.parent[c]).toBe(i)
        seen[c]++
        count++
      }
    }
    expect(count).toBe(t.n - 1)
    expect(seen.subarray(1).every((v) => v === 1)).toBe(true)
  })

  it('total_bytes of every dir is its own bytes plus its children totals', () => {
    for (const s of [small, big]) {
      const t = s.tree
      for (let i = 0; i < t.n; i++) {
        let sum = t.ownBytes[i]
        for (const c of t.children(i)) sum += t.totalBytes[c]
        expect(t.totalBytes[i]).toBe(sum)
      }
    }
  })
})

describe('pathOf / ancestry', () => {
  it('joins names below the root onto the root path', () => {
    const s = tiny()
    expect(pathOf(s.tree, s.meta.root, 0)).toBe('/abs/path')
    expect(pathOf(s.tree, s.meta.root, 2)).toBe('/abs/path/a/b')
    expect(ancestry(s.tree, 2)).toEqual([0, 1, 2])
  })

  it('does not double the slash for root "/"', () => {
    const s = tiny()
    expect(pathOf(s.tree, '/', 2)).toBe('/a/b')
    expect(pathOf(s.tree, '/', 0)).toBe('/')
  })

  it('every dir path in a real snapshot has depth == ancestry length - 1 and keeps odd names', () => {
    const t = big.tree
    for (let i = 0; i < t.n; i += 37) {
      const p = pathOf(t, big.meta.root, i)
      expect(p.split('/').length - big.meta.root.split('/').length).toBe(ancestry(t, i).length - 1)
    }
    const spaced = [...Array(small.tree.n).keys()].find((i) => small.tree.names[i].includes(' '))!
    expect(pathOf(small.tree, small.meta.root, spaced)).toContain('dir with space')
  })
})

describe('makeSubtreeTester', () => {
  const brute = (t: Tree, dir: number, anc: number) => ancestry(t, dir).includes(anc)

  it('agrees with a naive walk for random ancestors', () => {
    const t = big.tree
    const rnd = mulberry32(7)
    for (let k = 0; k < 20; k++) {
      const anc = Math.floor(rnd() * t.n)
      const inSub = makeSubtreeTester(t, anc)
      for (let j = 0; j < 400; j++) {
        const d = Math.floor(rnd() * t.n)
        expect(inSub(d)).toBe(brute(t, d, anc))
      }
    }
  })

  it('root contains everything, a dir contains itself, a leaf contains only itself', () => {
    const t = small.tree
    expect(makeSubtreeTester(t, 0)(t.n - 1)).toBe(true)
    const leaf = [...Array(t.n).keys()].find((i) => i > 0 && t.firstChild[i] === -1)!
    const inLeaf = makeSubtreeTester(t, leaf)
    expect(inLeaf(leaf)).toBe(true)
    expect(inLeaf(0)).toBe(false)
  })

  it('copes with dirs added after the tester was made (live mode)', () => {
    const t = new Tree(2)
    t.addDir(0, -1, 'r')
    t.addDir(1, 0, 'a')
    const inA = makeSubtreeTester(t, 1)
    t.addDir(2, 1, 'b')
    t.addDir(3, 0, 'c')
    expect(inA(2)).toBe(true)
    expect(inA(3)).toBe(false)
  })
})

describe('Tree growth', () => {
  it('doubles capacity and keeps data', () => {
    const t = new Tree(2)
    t.addDir(0, -1, 'r')
    for (let i = 1; i < 5000; i++) {
      t.addDir(i, Math.floor((i - 1) / 2), `d${i}`)
      t.totalBytes[i] = i
    }
    expect(t.n).toBe(5000)
    expect(t.totalBytes[4999]).toBe(4999)
    expect(t.parent[4999]).toBe(2499)
    expect(t.firstChild[2499]).toBe(4999)
  })
})
