// Reading dirscan's cache dir: index.json, scan state, last progress of a running scan.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function defaultCacheDir() {
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'dirscan')
}

/** The events stream sits next to its snapshot: `<name>.json` -> `<name>.events.ndjson`. */
export function eventsPathFor(snapshotFile) {
  const base = snapshotFile.endsWith('.json') ? snapshotFile.slice(0, -5) : snapshotFile
  return base + '.events.ndjson'
}

/** @returns {Promise<Record<string, any>>} the index, or {} if it is missing or unreadable */
export async function readIndex(cacheDir) {
  try {
    const idx = JSON.parse(await fs.promises.readFile(path.join(cacheDir, 'index.json'), 'utf8'))
    return idx && typeof idx === 'object' && !Array.isArray(idx) ? idx : {}
  } catch {
    return {}
  }
}

/**
 * Is `pid` a live process on this host? `kill(pid, 0)` says yes for any process, including a
 * recycled pid, so where /proc is readable also check that it still looks like the scanner.
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  let exists = true
  try {
    process.kill(pid, 0)
  } catch (e) {
    if (e.code !== 'EPERM') return false
    exists = true // someone else's process: still may be a scanner on a shared node
  }
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1')
    if (cmd && !/python|dirscan|gduscan/i.test(cmd)) return false // pid was reused by something else
  } catch {
    // no /proc, or cmdline hidden: trust kill()
  }
  return exists
}

/** running | done | partial | abandoned | remote */
export function deriveState(entry, { host = os.hostname(), alive = pidAlive } = {}) {
  if (entry.in_progress) {
    if (entry.host !== host) return 'remote'
    return alive(entry.pid) ? 'running' : 'abandoned'
  }
  return entry.complete ? 'done' : 'partial'
}

/** Latest `p` event of a running scan, read from the tail of its events file. */
export async function readLastProgress(eventsFile) {
  let fh
  try {
    fh = await fs.promises.open(eventsFile, 'r')
    const { size } = await fh.stat()
    const len = Math.min(size, 512 * 1024)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    const text = buf.toString('utf8')
    // newest `p` line that has its newline; the one being written right now is skipped
    for (let at = text.lastIndexOf('\n["p",'); at >= 0; at = text.lastIndexOf('\n["p",', at - 1)) {
      const end = text.indexOf('\n', at + 1)
      if (end < 0) continue
      const p = JSON.parse(text.slice(at + 1, end))
      return { files: p[1], dirs: p[2], bytes: p[3], errors: p[4], elapsed_s: p[5], current: p[6] }
    }
    return null
  } catch {
    return null
  } finally {
    await fh?.close()
  }
}

/**
 * Index entries plus derived state, running scans first, then newest.
 * @param {string} cacheDir
 * @param {{managed?: Set<string>}} [opts] snapshot keys of scans this server started
 */
export async function listScans(cacheDir, { managed = new Set() } = {}) {
  const index = await readIndex(cacheDir)
  const out = []
  for (const [file, e] of Object.entries(index)) {
    if (!e || typeof e.root !== 'string') continue
    const state = deriveState(e)
    const { events: _events, ...rest } = e
    const item = { ...rest, file, state, managed: managed.has(file) }
    if (state === 'running') item.progress = await readLastProgress(eventsPathFor(file))
    else if (state === 'done' || state === 'partial') {
      item.missing = !(await fs.promises.stat(file).then((s) => s.isFile(), () => false))
    }
    out.push(item)
  }
  const when = (x) => x.scanned_epoch || x.started_epoch || 0
  out.sort((a, b) => (b.state === 'running') - (a.state === 'running') || when(b) - when(a))
  return out
}
