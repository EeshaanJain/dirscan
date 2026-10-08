// Writing dirscan's cache files: index.json, the event stream and the snapshot (format version 2).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const CACHE_VERSION = 2
export const DIR_FIELDS = ['parent', 'name', 'own_bytes', 'own_files', 'total_bytes', 'total_files', 'flags']
export const FLAGS = { unreadable: 1, visited: 2, complete: 4 }

/** Same file name dirscan.py picks, so both engines share one snapshot key per (root, mode). */
export function cacheFileFor(root, mode, cacheDir) {
  const h = crypto.createHash('sha1').update(`${root}\0${mode}`, 'utf8').digest('hex').slice(0, 10)
  return path.join(cacheDir, `${path.basename(root) || 'root'}-${mode}-${h}.json`)
}

export const eventsFileFor = (cacheFile) => (cacheFile.endsWith('.json') ? cacheFile.slice(0, -5) : cacheFile) + '.events.ndjson'

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(obj))
  fs.renameSync(tmp, file) // atomic: readers never see a half-written file
}

export function readIndex(cacheDir) {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(cacheDir, 'index.json'), 'utf8'))
    return idx && typeof idx === 'object' && !Array.isArray(idx) ? idx : {}
  } catch {
    return {}
  }
}

export function updateIndex(file, entry) {
  const dir = path.dirname(file)
  const idx = readIndex(dir)
  idx[file] = entry
  writeJson(path.join(dir, 'index.json'), idx)
}

/** Append-only NDJSON event stream: one compact JSON array per line, flushed on demand. */
export class EventWriter {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.fd = fs.openSync(file, 'w') // truncates: a new scan starts the stream over
    this.buf = []
  }
  emit(...rec) {
    this.buf.push(JSON.stringify(rec))
  }
  flush() {
    if (!this.buf.length || this.fd === null) return
    fs.writeSync(this.fd, this.buf.join('\n') + '\n')
    this.buf = []
  }
  close() {
    this.flush()
    if (this.fd !== null) fs.closeSync(this.fd)
    this.fd = null
  }
}
