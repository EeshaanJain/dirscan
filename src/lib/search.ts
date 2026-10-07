// Fuzzy search over directory names and paths, written to stay fast at 1M dirs.
// cmdk's built-in filter would score every item with a string-similarity pass; here the
// palette does its own filtering, a bounded linear scan over the tree's name column.
//
// The query is split on whitespace and "/". The LAST token must match the dir's own name
// (exact > prefix > word-boundary > substring > subsequence); every earlier token must match
// the name of the dir itself or of an ancestor, in order (so "genbo ckpt" finds ckpt dirs
// under genbo, and "dir with space" still finds a dir literally named "dir with space 7").
//
// Two passes keep it cheap: the first only looks for exact/prefix/substring matches (native
// indexOf over a cached lowercase column); the slower in-order-subsequence pass ("srcx" ~
// "src_x") runs only when the first found next to nothing.

import type { Tree } from './tree'

export interface SearchHit {
  id: number
  score: number
}

const BOUNDARY = /[\s._\-/]/
/** the subsequence pass runs only when the substring pass found fewer hits than this */
const FUZZY_BELOW = 8

/** Lowercased names, computed once and extended as a live tree grows. */
const lowerCache = new WeakMap<Tree, string[]>()
function lowerNames(tree: Tree): string[] {
  let cache = lowerCache.get(tree)
  if (!cache) lowerCache.set(tree, (cache = []))
  for (let i = cache.length; i < tree.n; i++) cache[i] = tree.names[i].toLowerCase()
  return cache
}

/** Build the search index ahead of the first query (call when the browser is idle). */
export function warmSearchIndex(tree: Tree): void {
  lowerNames(tree)
}

function scoreSubstring(n: string, q: string): number {
  if (n === q) return 1000
  if (n.startsWith(q)) return 800 - Math.min(n.length - q.length, 100) / 4
  const i = n.indexOf(q)
  if (i < 0) return 0
  return (BOUNDARY.test(n[i - 1]) ? 600 : 500) - Math.min(i, 100) / 4
}

function scoreSubsequence(n: string, q: string): number {
  let j = 0
  for (let k = 0; k < n.length && j < q.length; k++) if (n.charCodeAt(k) === q.charCodeAt(j)) j++
  return j === q.length ? 300 - Math.min(n.length - q.length, 100) / 4 : 0
}

/** Nearest dir at or above `from` whose name contains `token`, or -1. */
function ancestorMatches(lower: string[], tree: Tree, from: number, token: string): number {
  for (let a = from; a >= 0; a = tree.parent[a]) {
    if (lower[a].includes(token)) return a
  }
  return -1
}

export function parseQuery(query: string): string[] {
  return query.toLowerCase().split(/[\s/]+/).filter(Boolean)
}

/**
 * @param tree the tree as discovered so far (works mid-scan)
 * @param limit maximum hits returned
 */
export function searchDirs(tree: Tree, query: string, limit = 200): SearchHit[] {
  const tokens = parseQuery(query)
  if (!tokens.length) return []
  const last = tokens[tokens.length - 1]
  const ancestors = tokens.slice(0, -1)
  const lower = lowerNames(tree)
  const n = tree.n

  const cmp = (a: SearchHit, b: SearchHit) => b.score - a.score || tree.totalBytes[b.id] - tree.totalBytes[a.id] || a.id - b.id
  const trim = (hits: SearchHit[]) => {
    hits.sort(cmp)
    hits.length = Math.min(hits.length, limit)
  }

  /** Does `id` satisfy the earlier tokens? Returns the score bonus, or -1. */
  const pathBonus = (id: number): number => {
    let bonus = 0
    let from = id
    for (let t = ancestors.length - 1; t >= 0; t--) {
      const a = ancestorMatches(lower, tree, from, ancestors[t])
      if (a < 0) return -1
      from = a // one dir may satisfy several tokens (names can contain spaces)
      bonus += 20
    }
    return bonus
  }

  const pass = (score: (name: string, q: string) => number): SearchHit[] => {
    const hits: SearchHit[] = []
    for (let id = 0; id < n; id++) {
      const s = score(lower[id], last)
      if (s === 0) continue
      const bonus = ancestors.length ? pathBonus(id) : 0
      if (bonus < 0) continue
      hits.push({ id, score: s + bonus })
      if (hits.length >= limit * 8) trim(hits) // amortised top-k
    }
    trim(hits)
    return hits
  }

  const hits = pass(scoreSubstring)
  if (hits.length < FUZZY_BELOW && last.length >= 2) {
    // too little found: also accept in-order subsequences, ranked below every substring hit
    const seen = new Set(hits.map((h) => h.id))
    for (const h of pass(scoreSubsequence)) {
      if (!seen.has(h.id)) hits.push(h)
    }
    trim(hits)
  }
  return hits
}
