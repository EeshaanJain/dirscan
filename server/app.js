// HTTP server: static UI, token-protected read-only API, and the two scan controls.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream'
import zlib from 'node:zlib'
import { deriveState, eventsPathFor, listScans, readIndex } from './cache.js'
import { GuardError, resolveInRoots } from './guard.js'
import { streamLive } from './live.js'
import { listDir } from './ls.js'
import { ScanError } from './scan.js'

export const TOKEN_HEADER = 'x-dirscan-token'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const sha = (s) => crypto.createHash('sha256').update(s).digest()

export function tokenOk(given, expected) {
  if (typeof given !== 'string') return false
  return crypto.timingSafeEqual(sha(given), sha(expected))
}

/** Host header's hostname, without port; loopback names only (blocks DNS rebinding). */
export function hostOk(hostHeader) {
  if (!hostHeader) return false
  const h = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0]
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

function httpStatusFor(e) {
  if (e.status) return e.status
  switch (e.code) {
    case 'EOUTSIDE':
    case 'EACCES':
    case 'EPERM':
      return 403
    case 'EINVAL':
    case 'ENOTDIR':
      return 400
    case 'ENOENT':
      return 404
    default:
      return 500
  }
}

function sendError(res, e) {
  if (res.headersSent) return res.end()
  const body = { error: e.message, code: e.code ?? 'EIO' }
  if (e.file) body.file = e.file
  sendJson(res, httpStatusFor(e), body)
}

async function readBody(req, limit = 64 * 1024) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new GuardError('EINVAL', 'request body too large')
    chunks.push(c)
  }
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new GuardError('EINVAL', 'body is not valid JSON')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new GuardError('EINVAL', 'body must be a JSON object')
  return body
}

/**
 * @param {object} cfg
 * @param {string} cfg.token
 * @param {string} cfg.cacheDir
 * @param {import('./scan.js').ScanManager} cfg.scans
 * @param {string[]} [cfg.cliRoots] roots given on the command line (also served by /api/ls)
 * @param {string[]} [cfg.cliFiles] snapshot files given on the command line
 * @param {string} [cfg.distDir] built UI
 */
export function createApp({ token, cacheDir, scans, cliRoots = [], cliFiles = [], distDir }) {
  const allowedFiles = new Set(cliFiles.map((f) => path.resolve(f)))

  const scanRoots = async () => {
    const roots = new Set(cliRoots.map((r) => path.resolve(r)))
    for (const e of Object.values(await readIndex(cacheDir))) if (typeof e?.root === 'string') roots.add(e.root)
    return [...roots]
  }

  async function api(req, res, url) {
    if (!tokenOk(req.headers[TOKEN_HEADER], token)) {
      return sendJson(res, 403, { error: 'missing or wrong token', code: 'ETOKEN' })
    }
    const route = `${req.method} ${url.pathname}`

    switch (route) {
      case 'GET /api/info':
        return sendJson(res, 200, { host: os.hostname(), cacheDir, cliRoots, version: 2 })

      case 'GET /api/scans':
        return sendJson(res, 200, await listScans(cacheDir, { managed: scans.managedKeys() }))

      case 'GET /api/snapshot': {
        const file = url.searchParams.get('file') ?? ''
        const index = await readIndex(cacheDir)
        if (!Object.hasOwn(index, file) && !allowedFiles.has(path.resolve(file))) {
          return sendJson(res, 403, { error: 'not a known snapshot', code: 'EOUTSIDE' })
        }
        let st
        try {
          st = await fs.promises.stat(file)
          if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' })
        } catch (e) {
          return sendError(res, e)
        }
        const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
        const gzip = /(^|[\s,])gzip(?!\s*;\s*q=0(\.0*)?(,|$))/.test(req.headers['accept-encoding'] ?? '')
        if (gzip) headers['Content-Encoding'] = 'gzip'
        // no Content-Length: the scanner replaces the file atomically, so the size from stat() may not be the one streamed
        res.writeHead(200, headers)
        const src = fs.createReadStream(file)
        return pipeline(...(gzip ? [src, zlib.createGzip({ level: 3 }), res] : [src, res]), () => {})
      }

      case 'GET /api/live': {
        const file = url.searchParams.get('file') ?? ''
        const index = await readIndex(cacheDir)
        if (!Object.hasOwn(index, file)) return sendJson(res, 404, { error: 'no such scan', code: 'ENOENT' })
        const state = deriveState(index[file])
        if (state === 'remote') {
          return sendJson(res, 409, { error: `scan is running on ${index[file].host}`, code: 'EREMOTE' })
        }
        return streamLive(req, res, {
          eventsFile: eventsPathFor(file),
          getState: async () => {
            const e = (await readIndex(cacheDir))[file]
            return e ? deriveState(e) : 'done'
          },
        })
      }

      case 'GET /api/ls': {
        const real = await resolveInRoots(url.searchParams.get('path'), await scanRoots())
        const ac = new AbortController()
        res.on('close', () => ac.abort())
        const listing = await listDir(real, { signal: ac.signal })
        return sendJson(res, 200, { ...listing, listedAt: Date.now() })
      }

      case 'POST /api/scan': {
        const body = await readBody(req)
        return sendJson(res, 200, await scans.start(body.root, body.du === true))
      }

      case 'POST /api/stop': {
        const body = await readBody(req)
        scans.stop(typeof body.file === 'string' ? body.file : '')
        return sendJson(res, 200, { ok: true })
      }

      default:
        return sendJson(res, 404, { error: 'unknown endpoint', code: 'ENOENT' })
    }
  }

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed', code: 'EINVAL' })
    if (!distDir || !fs.existsSync(path.join(distDir, 'index.html'))) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('The UI is not built yet. Run `npm run build`, or use `npm run dev`.\n')
    }
    let rel
    try {
      rel = decodeURIComponent(url.pathname)
    } catch {
      return sendJson(res, 400, { error: 'bad path', code: 'EINVAL' })
    }
    let file = path.join(distDir, rel === '/' ? 'index.html' : rel)
    if (!(file === distDir || file.startsWith(distDir + path.sep))) {
      return sendJson(res, 403, { error: 'forbidden', code: 'EOUTSIDE' })
    }
    let st = await fs.promises.stat(file).catch(() => null)
    if (!st?.isFile()) {
      if (rel !== '/') return sendJson(res, 404, { error: 'not found', code: 'ENOENT' })
      file = path.join(distDir, 'index.html')
      st = await fs.promises.stat(file)
    }
    const ext = path.extname(file)
    const html = ext === '.html'
    const headers = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    }
    if (html) headers['Content-Security-Policy'] = CSP
    res.writeHead(200, headers)
    if (req.method === 'HEAD') return res.end()
    // pipeline() closes the file if the client goes away; a bare .pipe() would leak the descriptor
    pipeline(fs.createReadStream(file), res, () => {})
  }

  return http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    if (!hostOk(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      return res.end('forbidden host\n')
    }
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      return res.end('bad request\n')
    }
    const run = url.pathname.startsWith('/api/') ? api(req, res, url) : serveStatic(req, res, url)
    run.catch((e) => {
      if (!(e instanceof GuardError || e instanceof ScanError) && !e?.code) console.error(e)
      sendError(res, e)
    })
  })
}
