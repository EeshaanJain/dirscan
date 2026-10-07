// Polling tail of an events file. fs.watch is unreliable on NFS/Lustre/GPFS, so callers
// poll `read()` on a timer; each call returns whatever complete lines were appended.

import fs from 'node:fs'
import { LineSplitter } from './ndjson.js'

const HEAD_BYTES = 4096

/**
 * The scanner truncates the file and starts over when a new scan begins. A shrunken file is
 * easy to spot, but a fast scan can regrow it past our offset between two polls, which would
 * leave us reading from the middle of a line. So the first line (the `h` header, which
 * carries the pid and start time) is remembered and re-checked on every read.
 */
export class Tailer {
  /** @param {string} file @param {{readSize?: number}} [opts] */
  constructor(file, { readSize = 1 << 20 } = {}) {
    this.file = file
    this.readSize = readSize
    this.offset = 0
    this.splitter = new LineSplitter()
    /** first line of the file as last seen, and whether its newline had arrived */
    this.head = null
    this.headDone = false
  }

  /**
   * Read the next chunk of at most `readSize` bytes.
   * @returns {Promise<{lines: string[], reset: boolean, eof: boolean, missing: boolean}>}
   *   `reset`: the file was restarted since the last call (lines are from its new beginning).
   *   `eof`: nothing more to read right now.
   */
  async read() {
    let fh
    try {
      fh = await fs.promises.open(this.file, 'r')
    } catch (e) {
      if (e.code === 'ENOENT') return { lines: [], reset: false, eof: true, missing: true }
      throw e
    }
    try {
      const { size } = await fh.stat()
      let reset = false

      const headBuf = Buffer.alloc(Math.min(HEAD_BYTES, size))
      if (headBuf.length) await fh.read(headBuf, 0, headBuf.length, 0)
      const nl = headBuf.indexOf(0x0a)
      const first = headBuf.toString('latin1', 0, nl < 0 ? headBuf.length : nl)
      const complete = nl >= 0 || headBuf.length >= HEAD_BYTES

      if (size < this.offset) {
        reset = true
      } else if (this.head !== null) {
        reset = this.headDone ? first !== this.head : !first.startsWith(this.head)
      }
      if (reset) {
        this.offset = 0
        this.splitter.reset()
        this.head = null
      }
      if (this.head === null || !this.headDone) {
        this.head = first
        this.headDone = complete
      }

      const want = Math.min(this.readSize, size - this.offset)
      if (want <= 0) return { lines: [], reset, eof: true, missing: false }
      const buf = Buffer.alloc(want)
      const { bytesRead } = await fh.read(buf, 0, want, this.offset)
      this.offset += bytesRead
      const lines = this.splitter.push(buf.subarray(0, bytesRead))
      return { lines, reset, eof: this.offset >= size, missing: false }
    } finally {
      await fh.close()
    }
  }
}
