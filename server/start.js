// Shared startup: figure out what the CLI target means, create the app, listen.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { deriveState, readIndex } from './cache.js'
import { findGdu, gduVersion } from '../scanner/gdu-bin.js'
import { ScanManager } from './scan.js'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The `root` field of a snapshot, read from its head (dirscan writes it right after `version`). */
export async function peekRoot(file) {
  const fh = await fs.promises.open(file, 'r')
  try {
    const buf = Buffer.alloc(16 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const m = /"root":\s*("(?:[^"\\]|\\.)*")/.exec(buf.toString('utf8', 0, bytesRead))
    if (m) return JSON.parse(m[1])
  } finally {
    await fh.close()
  }
  try {
    const snap = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    return typeof snap.root === 'string' ? snap.root : null
  } catch {
    return null
  }
}

const scanRoute = (file) => `#/scan?file=${encodeURIComponent(file)}`

/**
 * What does the CLI <path> argument mean?
 *  - a snapshot file            -> open it
 *  - a dir with --scan          -> start a scan (or attach to the one already running)
 *  - a dir                      -> its running scan, else its newest snapshot, else the dashboard
 * @returns {Promise<{route: string, cliRoots: string[], cliFiles: string[], notes: string[]}>}
 */
export async function resolveTarget({ target, scan, du, cacheDir }, scans) {
  const out = { route: '', cliRoots: [], cliFiles: [], notes: [] }
  if (!target) return out
  const abs = path.resolve(target)
  const st = await fs.promises.stat(abs).catch(() => null)

  if (st?.isFile()) {
    out.cliFiles.push(abs)
    const root = await peekRoot(abs)
    if (root) out.cliRoots.push(root)
    out.route = scanRoute(abs)
    return out
  }

  out.cliRoots.push(abs)
  const mode = du ? 'du' : 'apparent'

  if (scan) {
    if (!st?.isDirectory()) throw new Error(`not a directory: ${abs}`)
    try {
      const { file } = await scans.start(abs, du)
      out.notes.push(`started a ${mode} scan of ${abs}`)
      out.route = scanRoute(file)
    } catch (e) {
      if (e.code !== 'EALREADY' || !e.file) throw e
      out.notes.push(`${abs} is already being scanned; following it`)
      out.route = scanRoute(e.file)
    }
    return out
  }

  const candidates = new Set([abs])
  try {
    candidates.add(await fs.promises.realpath(abs))
  } catch {
    // path may not exist on this machine (scan done elsewhere on a shared cache)
  }
  const index = await readIndex(cacheDir)
  const usable = []
  for (const [file, e] of Object.entries(index)) {
    if (!candidates.has(e?.root)) continue
    const state = deriveState(e)
    if (state === 'running') usable.push({ file, e, running: true })
    else if ((state === 'done' || state === 'partial') && (await fs.promises.stat(file).catch(() => null))?.isFile()) {
      usable.push({ file, e, running: false })
    }
  }
  const when = (x) => x.e.scanned_epoch || x.e.started_epoch || 0
  usable.sort(
    (a, b) =>
      b.running - a.running ||
      (b.e.mode === mode) - (a.e.mode === mode) ||
      when(b) - when(a),
  )
  if (usable.length) {
    out.route = scanRoute(usable[0].file)
  } else {
    out.notes.push(`no scan of ${abs} in ${cacheDir}; showing the dashboard (add --scan to start one)`)
  }
  return out
}

/**
 * Which scanner the viewer starts. `auto` takes gdu when it can be found, else dirscan.py.
 * @returns {{command: string, args: string[], name: string, detail: string}}
 */
export function chooseScanner(opts) {
  const gdu = opts.engine === 'python' ? null : findGdu(opts.gdu)
  if (opts.engine === 'gdu' && !gdu) {
    throw new Error('--engine gdu, but no gdu was found (use --gdu PATH or $DIRSCAN_GDU)')
  }
  if (gdu) {
    return {
      command: process.execPath,
      args: [path.join(REPO_ROOT, 'scanner', 'gduscan.js'), '--gdu', gdu],
      name: 'gdu',
      detail: `${gduVersion(gdu) ?? 'gdu'} (${gdu})`,
    }
  }
  return { command: opts.python, args: [opts.scanner], name: 'python', detail: opts.scanner }
}

function listen(server, host, port, fixed) {
  const tries = fixed || port === 0 ? 1 : 20
  return (async () => {
    for (let i = 0; i < tries; i++) {
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(port + i, host, () => {
            server.off('error', reject)
            resolve()
          })
        })
        return server.address().port
      } catch (e) {
        if (e.code !== 'EADDRINUSE' || i === tries - 1) throw e
      }
    }
  })()
}

/**
 * @param {ReturnType<import('./args.js').parseCli>} opts
 * @param {{token?: string, distDir?: string}} [extra]
 */
export async function startServer(opts, { token, distDir = path.join(REPO_ROOT, 'dist') } = {}) {
  token ??= crypto.randomBytes(24).toString('base64url')
  const scanner = chooseScanner(opts)
  const scans = new ScanManager({ scanner, cacheDir: opts.cacheDir })
  const target = await resolveTarget(opts, scans)
  const server = createApp({
    token,
    cacheDir: opts.cacheDir,
    scans,
    cliRoots: target.cliRoots,
    cliFiles: target.cliFiles,
    distDir,
  })
  const port = await listen(server, opts.host, opts.port, opts.portFixed)
  return { server, port, token, scans, scanner, ...target }
}
