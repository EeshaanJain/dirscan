// In-memory result of a scan: the directory table, extension totals and the largest files.
// Semantics follow dirscan.py (format version 2, see VIEWER_SPEC.md) so either engine can feed
// the viewer: only regular files count, each hardlink counts, directories add no size of their own.

export const F_UNREADABLE = 1
export const F_VISITED = 2
export const F_COMPLETE = 4

export const NO_EXT = '[no ext]'

/** Python's os.path.splitext(name)[1].lower() or "[no ext]" (leading dots are not an extension). */
export function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  if (dot > 0) {
    for (let i = 0; i < dot; i++) if (name[i] !== '.') return name.slice(dot).toLowerCase()
  }
  return NO_EXT
}

/** Min-heap of the N largest files, ordered like dirscan.py's (size, mtime, dir, name) tuples. */
class Largest {
  constructor(n) {
    this.n = n
    this.h = []
  }
  static less(a, b) {
    return a.size !== b.size ? a.size < b.size : a.mtime !== b.mtime ? a.mtime < b.mtime : a.dir !== b.dir ? a.dir < b.dir : a.name < b.name
  }
  push(item) {
    const h = this.h
    if (this.n <= 0) return
    if (h.length < this.n) {
      h.push(item)
      for (let i = h.length - 1; i > 0; ) {
        const p = (i - 1) >> 1
        if (!Largest.less(h[i], h[p])) break
        ;[h[i], h[p]] = [h[p], h[i]]
        i = p
      }
    } else if (item.size > h[0].size) {
      h[0] = item
      for (let i = 0; ; ) {
        let m = i
        const l = 2 * i + 1
        const r = l + 1
        if (l < h.length && Largest.less(h[l], h[m])) m = l
        if (r < h.length && Largest.less(h[r], h[m])) m = r
        if (m === i) break
        ;[h[m], h[i]] = [h[i], h[m]]
        i = m
      }
    }
  }
  /** [[dir, name, bytes, mtime], …] largest first */
  list() {
    return [...this.h]
      .sort((a, b) => (Largest.less(b, a) ? -1 : Largest.less(a, b) ? 1 : 0))
      .map((x) => [x.dir, x.name, x.size, x.mtime])
  }
}

export class ScanState {
  /** @param {{rootName: string, largest?: number}} o */
  constructor({ rootName, largest = 1000 }) {
    this.parent = [-1]
    this.name = [rootName]
    this.ownBytes = [0]
    this.ownFiles = [0]
    this.flags = [0]
    this.totalBytes = null
    this.totalFiles = null
    this.extBytes = new Map()
    this.extFiles = new Map()
    this.largest = new Largest(largest)
    this.filesSeen = 0
    this.bytesSeen = 0
    this.errors = 0
    this.dirsVisited = 0
  }

  get dirCount() {
    return this.name.length
  }

  addDir(parent, name) {
    this.parent.push(parent)
    this.name.push(name)
    this.ownBytes.push(0)
    this.ownFiles.push(0)
    this.flags.push(0)
    return this.name.length - 1
  }

  /** One regular file: feeds the extension totals and the largest-files list. */
  noteFile(dir, name, size, mtime) {
    const ext = extensionOf(name)
    this.extBytes.set(ext, (this.extBytes.get(ext) ?? 0) + size)
    this.extFiles.set(ext, (this.extFiles.get(ext) ?? 0) + 1)
    this.largest.push({ size, mtime, dir, name })
  }

  /**
   * A directory is done: its own files are now counted. Called once per directory, together with
   * the `s` event, so the dir table never holds more than the event stream has told the viewer.
   */
  visit(id, bytes, files, unreadable = false) {
    this.ownBytes[id] = bytes
    this.ownFiles[id] = files
    this.flags[id] |= F_VISITED | (unreadable ? F_UNREADABLE : 0)
    this.filesSeen += files
    this.bytesSeen += bytes
    this.dirsVisited++
  }

  isVisited(id) {
    return (this.flags[id] & F_VISITED) !== 0
  }

  largestList() {
    return this.largest.list()
  }

  extensions() {
    const out = {}
    for (const [e, b] of this.extBytes) out[e] = { files: this.extFiles.get(e), bytes: b }
    return out
  }

  /** Totals and subtree-complete flags, children after parents (the finalize_totals of dirscan.py). */
  finalize() {
    const n = this.name.length
    this.totalBytes = Float64Array.from(this.ownBytes)
    this.totalFiles = Float64Array.from(this.ownFiles)
    for (let i = 0; i < n; i++) {
      this.flags[i] = this.flags[i] & F_VISITED ? this.flags[i] | F_COMPLETE : this.flags[i] & ~F_COMPLETE
    }
    for (let i = n - 1; i > 0; i--) {
      const p = this.parent[i]
      this.totalBytes[p] += this.totalBytes[i]
      this.totalFiles[p] += this.totalFiles[i]
      if (!(this.flags[i] & F_COMPLETE)) this.flags[p] &= ~F_COMPLETE
    }
  }

  /** The dir_fields rows: [parent, name, own_bytes, own_files, total_bytes, total_files, flags]. */
  rows() {
    const out = new Array(this.name.length)
    for (let i = 0; i < out.length; i++) {
      out[i] = [this.parent[i], this.name[i], this.ownBytes[i], this.ownFiles[i], this.totalBytes[i], this.totalFiles[i], this.flags[i]]
    }
    return out
  }
}
