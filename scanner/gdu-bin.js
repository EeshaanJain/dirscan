import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const executable = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * The gdu to use. An explicit path is taken as given (null if it is not an executable: asking
 * for one gdu and silently getting another would be worse than failing). Otherwise
 * $DIRSCAN_GDU, then $PATH. Null if none.
 */
export function findGdu(explicit) {
  if (explicit) return executable(explicit) ? explicit : null
  const candidates = [process.env.DIRSCAN_GDU]
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, 'gdu'))
  return candidates.find((c) => c && executable(c)) ?? null
}

/** "v5.37.0" from `gdu --version`, or null. */
export function gduVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  return /Version:\s*(\S+)/.exec(r.stdout ?? '')?.[1] ?? null
}
