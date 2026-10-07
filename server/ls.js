// Live directory listing straight from the filesystem (opendir + lstat). Read-only.

import fs from 'node:fs'
import path from 'node:path'

export const LS_LIMIT = 5000

function typeOf(st) {
  if (st.isFile()) return 'file'
  if (st.isDirectory()) return 'dir'
  if (st.isSymbolicLink()) return 'symlink'
  return 'other'
}

/**
 * List `dir` (an already-guarded real path).
 *
 * Every entry is lstat'ed (so the response can be sorted by size), a bounded number at a time.
 * Entries that vanish between readdir and lstat are skipped. The response carries at most
 * `limit` entries, largest first; `total` is the number listed.
 *
 * @param {string} dir
 * @param {{limit?: number, concurrency?: number, signal?: AbortSignal}} [opts]
 */
export async function listDir(dir, { limit = LS_LIMIT, concurrency = 64, signal } = {}) {
  const names = []
  // for-await closes the handle when the loop ends or is left early
  for await (const d of await fs.promises.opendir(dir)) {
    names.push(d.name)
    if (signal?.aborted) throw new Error('aborted')
  }

  const entries = []
  let skipped = 0
  let next = 0
  const worker = async () => {
    while (next < names.length) {
      if (signal?.aborted) return
      const name = names[next++]
      try {
        const full = path.join(dir, name)
        const st = await fs.promises.lstat(full)
        const e = {
          name,
          type: typeOf(st),
          size: st.size,
          blocks: st.blocks,
          mtime: Math.floor(st.mtimeMs / 1000),
          mode: st.mode,
          uid: st.uid,
        }
        if (e.type === 'symlink') {
          try {
            e.target = await fs.promises.readlink(full)
          } catch {
            // leave target unset
          }
        }
        entries.push(e)
      } catch {
        skipped++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, names.length)) }, worker))
  if (signal?.aborted) throw new Error('aborted')

  entries.sort((a, b) => b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const total = entries.length
  const out = { path: dir, total, skipped, truncated: total > limit, entries: entries.slice(0, limit) }
  return out
}
