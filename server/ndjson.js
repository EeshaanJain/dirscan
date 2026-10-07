// Incremental newline splitter for the tailed events file. The scanner flushes on a timer,
// so a read can end in the middle of a line (or of a multi-byte character): the unfinished
// tail is held back until its newline arrives.

export class LineSplitter {
  constructor() {
    /** @type {Buffer} */
    this.rest = Buffer.alloc(0)
  }

  /**
   * @param {Buffer} chunk raw bytes appended to the file since the last call
   * @returns {string[]} complete, non-empty lines (without their terminators)
   */
  push(chunk) {
    const data = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk
    const end = data.lastIndexOf(0x0a)
    if (end < 0) {
      this.rest = Buffer.from(data) // copy: `chunk` may be a reused read buffer
      return []
    }
    this.rest = Buffer.from(data.subarray(end + 1))
    const lines = data.toString('utf8', 0, end).split('\n')
    const out = []
    for (let l of lines) {
      if (l.endsWith('\r')) l = l.slice(0, -1)
      if (l) out.push(l)
    }
    return out
  }

  /** Bytes buffered while waiting for a newline. */
  get pending() {
    return this.rest.length
  }

  reset() {
    this.rest = Buffer.alloc(0)
  }
}
