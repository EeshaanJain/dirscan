import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseCli } from '../server/args.js'
import { REPO_ROOT, startServer } from '../server/start.js'
import { TOKEN_HEADER } from '../server/app.js'
import { CACHE_DIR } from './fixtures'

export const tmpDir = (prefix = 'dirscan-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

/** Copy the generated fixtures into a fresh cache dir, rewriting the index to point at the copy. */
export function makeCache() {
  const dir = tmpDir('dirscan-cache-')
  const src = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'index.json'), 'utf8')) as Record<string, any>
  const index: Record<string, any> = {}
  for (const [key, e] of Object.entries(src)) {
    const base = path.basename(key)
    fs.copyFileSync(path.join(CACHE_DIR, base), path.join(dir, base))
    const ev = path.basename(e.events)
    fs.copyFileSync(path.join(CACHE_DIR, ev), path.join(dir, ev))
    index[path.join(dir, base)] = { ...e, events: path.join(dir, ev) }
  }
  writeIndex(dir, index)
  return { dir, index, keyOf: (name: string) => Object.keys(index).find((k) => path.basename(k).startsWith(name + '-'))! }
}

export function writeIndex(dir: string, index: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index))
}

export function readIndexSync(dir: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
}

/** A pid that certainly belonged to a process on this host and is gone now. */
export function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''])
  return r.pid
}

export interface TestServer {
  base: string
  token: string
  cacheDir: string
  close: () => Promise<void>
  api: (p: string, init?: RequestInit & { token?: string | null }) => Promise<Response>
  json: (p: string, init?: RequestInit) => Promise<{ status: number; body: any }>
  scans: Awaited<ReturnType<typeof startServer>>['scans']
}

export async function startTestServer(
  cacheDir: string,
  { args = [] as string[], distDir }: { args?: string[]; distDir?: string } = {},
): Promise<TestServer> {
  const opts = parseCli(['--port', '0', '--no-open', '--engine', 'python', '--cache-dir', cacheDir, ...args], REPO_ROOT)
  const { server, port, token, scans } = await startServer(opts, { distDir: distDir ?? path.join(cacheDir, 'no-dist') })
  const base = `http://127.0.0.1:${port}`
  const api: TestServer['api'] = (p, init = {}) => {
    const { token: t = token, ...rest } = init
    const headers = new Headers(rest.headers)
    if (t !== null) headers.set(TOKEN_HEADER, t)
    return fetch(base + p, { ...rest, headers })
  }
  return {
    base,
    token,
    cacheDir,
    scans,
    api,
    json: async (p, init) => {
      const r = await api(p, init)
      return { status: r.status, body: await r.json() }
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    },
  }
}

/** Parse an SSE body into messages; comment lines (": keepalive") are skipped. */
export function parseSse(text: string) {
  const out: { event: string; data: string }[] = []
  for (const block of text.split('\n\n')) {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) data.push(line.slice(6))
    }
    if (data.length) out.push({ event, data: data.join('\n') })
  }
  return out
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor<T>(fn: () => T | Promise<T>, what: string, ms = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}
