// Splitting the top of the tree into chunks that gdu scans one at a time.
//
// gdu writes its export only when it finishes, so one run over a whole tree gives the viewer
// nothing to show until the end. Instead the first few levels are read here (cheap: just those
// directories), and gdu is run on each directory below them. Each finished chunk is turned into
// events at once, so the treemap fills in chunk by chunk and finished subtrees get their tick.
//
// A directory is only expanded here if reading it is cheap (not millions of entries, not
// thousands of subdirectories); otherwise it becomes a chunk itself and gdu does the work.

import fs from 'node:fs/promises'
import path from 'node:path'

// 64 pieces measured as fast as 24 on a 1.5M-file tree and twice as smooth to watch; 400 was slower
export const DEFAULTS = { minChunks: 64, maxDepth: 3, maxEntries: 20_000, maxSubdirs: 256, concurrency: 32 }

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * @param {object} o
 * @param {string} o.root absolute path of the scan root (dir id 0)
 * @param {import('./state.js').ScanState} o.state
 * @param {(...rec: unknown[]) => void} o.emit event sink
 * @param {boolean} o.du count allocated blocks instead of apparent size
 * @param {() => boolean} [o.stopped]
 * @param {number} [o.minChunks] look one level further until there are at least this many pieces
 * @param {number} [o.maxDepth] ...but never expand more levels than this
 * @param {number} [o.maxEntries] a directory with more entries is scanned by gdu whole
 * @param {number} [o.maxSubdirs] likewise for one with more subdirectories
 * @param {number} [o.concurrency] parallel lstat calls
 * @returns {Promise<{id: number, path: string}[]>} directories gdu must scan
 */
export async function planChunks({ root, state, emit, du, stopped = () => false, ...opts }) {
  const cfg = { ...DEFAULTS, ...opts }
  const chunks = []
  let frontier = [{ id: 0, path: root }]

  for (let depth = 0; frontier.length; depth++) {
    const next = []
    const results = await mapLimit(frontier, 8, async (d) => {
      if (stopped()) return null
      try {
        return { d, list: await fs.readdir(d.path, { withFileTypes: true }) }
      } catch {
        return { d, list: null }
      }
    })
    for (const r of results) {
      if (!r || stopped()) continue
      const { d, list } = r
      if (list === null) {
        // cannot even list it: an unreadable, finished directory
        state.errors++
        state.visit(d.id, 0, 0, true)
        emit('s', d.id, 0, 0, state.flags[d.id])
        continue
      }
      const subdirs = list.filter((e) => e.isDirectory())
      if (list.length > cfg.maxEntries || subdirs.length > cfg.maxSubdirs) {
        chunks.push(d) // too big to read here: gdu takes the whole directory
        continue
      }
      for (const e of subdirs) {
        const id = state.addDir(d.id, e.name)
        emit('n', id, d.id, e.name)
        next.push({ id, path: path.join(d.path, e.name) })
      }
      // this directory's own files, counted like dirscan.py: regular files only
      let bytes = 0
      let files = 0
      const regular = list.filter((e) => e.isFile())
      await mapLimit(regular, cfg.concurrency, async (e) => {
        try {
          const st = await fs.lstat(path.join(d.path, e.name))
          const size = du ? st.blocks * 512 : st.size
          bytes += size
          files++
          state.noteFile(d.id, e.name, size, Math.floor(st.mtimeMs / 1000))
        } catch {
          state.errors++
        }
      })
      state.visit(d.id, bytes, files)
      emit('s', d.id, bytes, files, state.flags[d.id])
    }
    if (!next.length) break
    // enough pieces (or deep enough): the next level becomes the chunks; otherwise look one level further
    if (next.length >= cfg.minChunks || depth + 1 >= cfg.maxDepth) {
      chunks.push(...next)
      break
    }
    frontier = next
  }
  return chunks
}
