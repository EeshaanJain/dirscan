// Path guard for /api/ls: only paths that, after symlink resolution, lie inside the root of
// a known scan are served.

import fs from 'node:fs'
import path from 'node:path'

export class GuardError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function inside(child, root) {
  if (child === root) return true
  return child.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

/**
 * Walk `p` one component at a time with the kernel's own resolution (so `..` after a symlink
 * is honoured) and check that every prefix that resolves is inside a root, or is a directory
 * above one (the way down to it).
 */
async function resolvedPrefixesInside(p, allowed) {
  const parts = p.split('/').filter((c) => c !== '')
  let cur = ''
  for (const part of parts) {
    cur += '/' + part
    let real
    try {
      real = await fs.promises.realpath(cur)
    } catch {
      return true // first prefix that does not resolve: everything before it was inside
    }
    const ok = allowed.some((r) => inside(real, r) || inside(r, real))
    if (!ok) return false
  }
  return true
}

/**
 * Resolve `p` to its real path and make sure it is inside one of `roots`.
 *
 * `p` is handed to realpath untouched, so `..` after a symlink follows the kernel's rules
 * (not a lexical normalisation that a symlink could contradict). If it cannot be resolved,
 * the error is only revealed when the path was lexically inside a root; anything else gets
 * the same EOUTSIDE answer an existing outside path would, so the API can't be used to
 * probe for files elsewhere.
 *
 * @param {unknown} p requested absolute path
 * @param {string[]} roots scan roots (absolute)
 * @returns {Promise<string>} the real path
 */
export async function resolveInRoots(p, roots) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) throw new GuardError('EINVAL', 'bad path')
  if (!path.isAbsolute(p)) throw new GuardError('EINVAL', 'path must be absolute')

  const lexical = path.resolve(p)
  const allowed = []
  for (const r of roots) {
    const abs = path.resolve(r)
    allowed.push(abs)
    try {
      allowed.push(await fs.promises.realpath(abs))
    } catch {
      // root no longer exists (e.g. a remote scan's root): only its lexical form can match
    }
  }

  let real
  try {
    real = await fs.promises.realpath(p)
  } catch (e) {
    // The real error (ENOENT, EACCES, …) is only shown if every part of the path that does
    // resolve stays inside a root. Otherwise `root/link/x`, with link -> /etc, would tell
    // apart "no such file" from "exists but outside" and let callers probe the filesystem.
    if (!allowed.some((r) => inside(lexical, r)) || !(await resolvedPrefixesInside(p, allowed))) {
      throw new GuardError('EOUTSIDE', 'path is outside every scanned root')
    }
    throw e
  }
  if (!allowed.some((r) => inside(real, r))) {
    throw new GuardError('EOUTSIDE', 'path is outside every scanned root')
  }
  return real
}
