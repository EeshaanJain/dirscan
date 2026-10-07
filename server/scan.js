// Starting and stopping dirscan.py. This is the only process the viewer ever spawns, and
// the only one it will signal is one it started itself.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { deriveState, readIndex } from './cache.js'

export class ScanError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export class ScanManager {
  /** @param {{scanner: string, python: string, cacheDir: string}} cfg */
  constructor({ scanner, python, cacheDir }) {
    this.scanner = scanner
    this.python = python
    this.cacheDir = cacheDir
    /** snapshot key -> ChildProcess, for scans this server started and that are still alive */
    this.children = new Map()
    /** "<root>\0<mode>" of scans being started (closes the race between two requests) */
    this.starting = new Set()
    /** children already sent SIGTERM */
    this.stopping = new WeakSet()
  }

  managedKeys() {
    return new Set(this.children.keys())
  }

  /**
   * Start `dirscan.py <root> --rescan --quiet [--du]`, detached in its own process group.
   * Resolves with the snapshot key once the scanner has registered itself in the index.
   * @returns {Promise<{file: string, pid: number}>}
   */
  async start(root, du) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new ScanError(400, 'EINVAL', 'root must be an absolute path')
    }
    root = path.resolve(root)
    const mode = du ? 'du' : 'apparent'
    let st
    try {
      st = await fs.promises.stat(root)
    } catch (e) {
      throw new ScanError(400, e.code ?? 'ENOENT', `cannot read ${root}: ${e.message}`)
    }
    if (!st.isDirectory()) throw new ScanError(400, 'ENOTDIR', `not a directory: ${root}`)

    const lock = `${root}\0${mode}`
    if (this.starting.has(lock)) throw new ScanError(409, 'EALREADY', 'a scan of this path is starting')
    this.starting.add(lock)
    try {
      const before = await readIndex(this.cacheDir)
      const running = Object.entries(before).find(
        ([, e]) => e?.root === root && e.mode === mode && deriveState(e) === 'running',
      )
      if (running) {
        throw Object.assign(new ScanError(409, 'EALREADY', 'this path is already being scanned'), { file: running[0] })
      }

      const args = [this.scanner, root, '--rescan', '--quiet', '--cache-dir', this.cacheDir]
      if (du) args.push('--du')
      const spawnedAt = Math.floor(Date.now() / 1000)
      const child = spawn(this.python, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (d) => {
        if (stderr.length < 4096) stderr += d
      })
      const exited = new Promise((resolve) => {
        child.once('error', (e) => resolve({ error: e }))
        child.once('exit', (code, signal) => resolve({ code, signal }))
      })
      child.unref()

      // The scanner writes an index entry carrying its pid before it starts walking. A tiny
      // scan can finish before we look, and the final entry has no pid, so fall back to
      // matching root + mode + a start time no earlier than our spawn.
      const unchanged = (key, e) => JSON.stringify(before[key]) === JSON.stringify(e)
      const find = (idx) => {
        const entries = Object.entries(idx)
        return (
          // the pid alone could be a stale entry whose pid was recycled: root and mode must agree too
          entries.find(([k, e]) => e?.pid === child.pid && e.in_progress && e.root === root && e.mode === mode && !unchanged(k, e)) ??
          entries.find(([k, e]) => e?.root === root && e.mode === mode && e.started_epoch >= spawnedAt && !unchanged(k, e))
        )
      }
      const deadline = Date.now() + 10_000
      for (;;) {
        const hit = find(await readIndex(this.cacheDir))
        if (hit) {
          const key = hit[0]
          if (hit[1].in_progress) {
            this.children.set(key, child)
            exited.then(() => {
              if (this.children.get(key) === child) this.children.delete(key)
            })
          }
          return { file: key, pid: child.pid }
        }
        const done = await Promise.race([exited, new Promise((r) => setTimeout(r, 50))])
        if (done) {
          const again = find(await readIndex(this.cacheDir)) // it may have registered just before exiting
          if (again) return { file: again[0], pid: child.pid }
          const why = done.error ? done.error.message : stderr.trim() || `exit ${done.code ?? done.signal}`
          throw new ScanError(500, 'ESPAWN', `scanner failed to start: ${why}`)
        }
        if (Date.now() > deadline) {
          child.kill('SIGTERM')
          throw new ScanError(500, 'ETIMEDOUT', 'scanner did not register in the index')
        }
      }
    } finally {
      this.starting.delete(lock)
    }
  }

  /** SIGTERM a scan this server started; the scanner then writes a partial snapshot. */
  stop(file) {
    const child = this.children.get(file)
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      throw new ScanError(409, 'ENOTMANAGED', 'this server did not start a running scan with that key')
    }
    // dirscan's shutdown (writing the partial snapshot) is not re-entrant: a second SIGTERM
    // while it is writing can leave no snapshot at all, so Stop is a one-shot per scan.
    if (this.stopping.has(child)) return
    this.stopping.add(child)
    child.kill('SIGTERM')
  }
}
