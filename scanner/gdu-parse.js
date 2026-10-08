// Streaming reader for gdu's JSON export (`gdu -o file`, ncdu-compatible shape):
//
//   [1,2,{meta},
//   [{"name":"/root","asize":…},          <- a directory is an array: its own record first,
//   {"name":"file","asize":3,…},             then its files (objects) and subdirectories (arrays)
//   [{"name":"sub",…},
//   {"name":"x",…}]]]                     <- trailing ] close the open directories
//
// gdu writes one entry per line, so the file can be read line by line (reports run to many GB,
// far past what JSON.parse can hold). gdu's own per-directory totals are ignored: callers sum
// the file entries themselves so sizes mean what dirscan.py's did.

import fs from 'node:fs'
import readline from 'node:readline'

export class GduFormatError extends Error {}

/**
 * Parse one export line into what it opens/holds/closes.
 * @returns {{open: boolean, entry: object|null, closes: number}}
 */
export function parseLine(line) {
  let s = line
  let open = false
  if (s.startsWith('[')) {
    open = true
    s = s.slice(1)
  }
  let closes = 0
  let entry = null
  const end = s.lastIndexOf('}')
  if (end >= 0) {
    // the object ends at the last "}" on the line; only , and ] may follow it
    const tail = s.slice(end + 1)
    if (!/^[,\]]*$/.test(tail)) throw new GduFormatError(`unexpected text after entry: ${line.slice(0, 120)}`)
    for (const ch of tail) if (ch === ']') closes++
    try {
      entry = JSON.parse(s.slice(0, end + 1))
    } catch (e) {
      throw new GduFormatError(`bad entry (${e.message}): ${line.slice(0, 120)}`)
    }
  } else if (/^[,\]]*$/.test(s)) {
    for (const ch of s) if (ch === ']') closes++
  } else {
    throw new GduFormatError(`unrecognised line: ${line.slice(0, 120)}`)
  }
  if (open && !entry) throw new GduFormatError(`directory without a record: ${line.slice(0, 120)}`)
  return { open, entry, closes }
}

/**
 * Walk an export. Callbacks, in file order:
 *   dir(entry)   a directory opens (first call: the scanned root)
 *   file(entry)  an entry that is not a directory, in the directory most recently opened and not yet closed
 *   close()      the current directory ends
 * `entry.notreg` marks symlinks and other non-regular files.
 *
 * @param {string} file
 * @param {{dir: (e: any) => void, file: (e: any) => void, close: () => void}} h
 * @returns {Promise<{depthLeft: number}>} depthLeft > 0 means the export was cut off
 */
export async function readGdu(file, h) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  let depth = 0
  let started = false
  for await (const line of rl) {
    if (!line) continue
    if (!started) {
      // header: [1,2,{meta},  (the first directory follows on the next line)
      if (line.startsWith('[1,')) continue
      started = true
    }
    const { open, entry, closes } = parseLine(line)
    if (open) {
      depth++
      h.dir(entry)
    } else if (entry) {
      if (depth === 0) throw new GduFormatError('entry outside any directory')
      h.file(entry)
    }
    for (let i = 0; i < closes && depth > 0; i++) {
      depth--
      h.close()
    }
  }
  return { depthLeft: depth }
}
