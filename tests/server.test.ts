import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyEvents, createLiveState, type LiveEvent } from '@/lib/events'
import { parseSnapshot } from '@/lib/snapshot'
import { parseCli, isLoopback } from '../server/args.js'
import { hostOk } from '../server/app.js'
import { deriveState, eventsPathFor, listScans } from '../server/cache.js'
import { resolveTarget, REPO_ROOT } from '../server/start.js'
import { batches } from '../server/live.js'
import { loadFixtures } from './fixtures'
import {
  deadPid, makeCache, parseSse, readIndexSync, sleep, startTestServer, tmpDir, waitFor, writeIndex,
  type TestServer,
} from './server-helpers'

const fixtures = loadFixtures()
const isRoot = process.getuid?.() === 0

/** A long-lived python process: stands in for a running scanner so pid checks see "alive". */
function fakeScanner(): ChildProcess {
  return spawn('python3', ['-c', 'import time; time.sleep(120)'], { stdio: 'ignore' })
}

describe('auth and host checks', () => {
  let cache: ReturnType<typeof makeCache>
  let srv: TestServer
  beforeAll(async () => {
    cache = makeCache()
    srv = await startTestServer(cache.dir)
  })
  afterAll(() => srv.close())

  const endpoints: [string, string][] = [
    ['GET', '/api/info'], ['GET', '/api/scans'], ['GET', '/api/snapshot?file=x'], ['GET', '/api/live?file=x'],
    ['GET', '/api/ls?path=/'], ['POST', '/api/scan'], ['POST', '/api/stop'], ['GET', '/api/nope'],
  ]
  for (const [method, p] of endpoints) {
    it(`${method} ${p}: 403 without a token, and with a wrong one`, async () => {
      expect((await srv.api(p, { method, token: null })).status).toBe(403)
      expect((await srv.api(p, { method, token: 'wrong' })).status).toBe(403)
      expect((await srv.api(p, { method, token: srv.token + 'x' })).status).toBe(403)
    })
  }

  it('does not accept the token in the query string', async () => {
    const r = await srv.api(`/api/scans?token=${srv.token}`, { token: null })
    expect(r.status).toBe(403)
  })

  it('accepts the right token', async () => {
    const { status, body } = await srv.json('/api/info')
    expect(status).toBe(200)
    expect(body.host).toBe(os.hostname())
  })

  it('rejects a non-loopback Host header (DNS rebinding)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        srv.base + '/api/scans',
        { headers: { host: 'evil.example:80', 'x-dirscan-token': srv.token } },
        (res) => {
          res.resume()
          resolve(res.statusCode!)
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
  })

  it('accepts loopback Host names on any port (a tunnel may use a different local port) and nothing else', () => {
    for (const h of ['127.0.0.1:4173', 'localhost:8000', 'localhost', '127.0.0.1', '[::1]:4173', '[::1]']) expect(hostOk(h), h).toBe(true)
    for (const h of ['evil.example', 'evil.example:4173', '127.0.0.1.evil.example', 'localhost.evil.example:80', '10.0.0.5:4173', '', undefined]) {
      expect(hostOk(h as string), String(h)).toBe(false)
    }
  })

  it('answers no CORS preflight', async () => {
    const r = await fetch(srv.base + '/api/scans', { method: 'OPTIONS', headers: { origin: 'http://evil.example' } })
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
    expect(r.status).toBe(403)
  })
})

describe('/api/scans', () => {
  it('derives running / abandoned / remote / done / partial and sorts running first', async () => {
    const cache = makeCache()
    const alive = fakeScanner()
    try {
      const index = readIndexSync(cache.dir)
      const base = { mode: 'apparent', started_epoch: 1_700_000_000, complete: false, in_progress: true }
      index['/x/running.json'] = { ...base, root: '/r/running', host: os.hostname(), pid: alive.pid }
      index['/x/abandoned.json'] = { ...base, root: '/r/abandoned', host: os.hostname(), pid: deadPid() }
      index['/x/remote.json'] = { ...base, root: '/r/remote', host: 'some-other-node', pid: 1 }
      writeIndex(cache.dir, index)

      const scans = await listScans(cache.dir)
      const state = (root: string) => scans.find((s) => s.root === root)?.state
      expect(state('/r/running')).toBe('running')
      expect(state('/r/abandoned')).toBe('abandoned')
      expect(state('/r/remote')).toBe('remote')
      expect(scans.find((s) => s.root.endsWith('/small') && s.mode === 'apparent')?.state).toBe('done')
      expect(scans.find((s) => s.root.endsWith('/big'))?.state).toBe('partial')
      expect(scans[0].state).toBe('running')
      expect(scans.every((s) => !('events' in s))).toBe(true)

      const srv = await startTestServer(cache.dir)
      const { body } = await srv.json('/api/scans')
      expect(body[0].file).toBe('/x/running.json')
      expect(body.map((s: any) => s.state)).toContain('remote')
      await srv.close()
    } finally {
      alive.kill()
    }
  })

  it('a live pid that turns out to be some other program counts as abandoned (pid reuse)', async () => {
    if (!fs.existsSync('/proc/self/cmdline')) return // refinement needs /proc
    const other = spawn('sleep', ['120'], { stdio: 'ignore' })
    const py = fakeScanner()
    try {
      await sleep(100)
      const entry = (pid: number) => ({ in_progress: true, host: os.hostname(), pid })
      expect(deriveState(entry(other.pid!))).toBe('abandoned')
      expect(deriveState(entry(py.pid!))).toBe('running')
    } finally {
      other.kill()
      py.kill()
    }
  })

  it('reports the latest progress of a running scan from its events file', async () => {
    const cache = makeCache()
    const alive = fakeScanner()
    try {
      const key = path.join(cache.dir, 'prog-apparent-1.json')
      fs.writeFileSync(
        eventsPathFor(key),
        ['["h",{"pid":1}]', '["p",1,2,3,0,0.5,"/a"]', '["L",[]]', '["p",10,20,30,4,1.5,"/b/c"]', '["p",99,'].join('\n'),
      )
      const index = readIndexSync(cache.dir)
      index[key] = { root: '/r/prog', mode: 'apparent', host: os.hostname(), pid: alive.pid, in_progress: true, complete: false, started_epoch: 1 }
      writeIndex(cache.dir, index)
      const s = (await listScans(cache.dir)).find((x) => x.root === '/r/prog')!
      expect(s.progress).toEqual({ files: 10, dirs: 20, bytes: 30, errors: 4, elapsed_s: 1.5, current: '/b/c' })
    } finally {
      alive.kill()
    }
  })
})

describe('/api/snapshot', () => {
  let cache: ReturnType<typeof makeCache>
  let srv: TestServer
  beforeAll(async () => {
    cache = makeCache()
    srv = await startTestServer(cache.dir)
  })
  afterAll(() => srv.close())

  it('streams a snapshot listed in the index, identical to the file', async () => {
    const key = cache.keyOf('small')
    const r = await srv.api(`/api/snapshot?file=${encodeURIComponent(key)}`, { headers: { 'accept-encoding': 'identity' } })
    expect(r.status).toBe(200)
    // no Content-Length on purpose: dirscan replaces the file atomically, so a size taken from stat() could disagree
    expect(r.headers.get('content-length')).toBeNull()
    expect(Buffer.from(await r.arrayBuffer()).equals(fs.readFileSync(key))).toBe(true)
  })

  it('gzips when asked, and the result parses to the same snapshot', async () => {
    const key = cache.keyOf('big')
    const r = await srv.api(`/api/snapshot?file=${encodeURIComponent(key)}`) // fetch sends accept-encoding: gzip
    expect(r.status).toBe(200)
    const snap = parseSnapshot(await r.text())
    expect(snap.tree.n).toBeGreaterThan(1000)
  })

  it('refuses files that are not in the index', async () => {
    for (const f of [
      '/etc/passwd',
      path.join(cache.dir, 'index.json'),
      cache.keyOf('small') + '/../index.json',
      path.join(cache.dir, '..', 'x.json'),
      '',
    ]) {
      const { status } = await srv.json(`/api/snapshot?file=${encodeURIComponent(f)}`)
      expect(status, f).toBe(403)
    }
  })

  it('serves a snapshot file passed on the command line even if it is not indexed', async () => {
    const outside = tmpDir()
    const copy = path.join(outside, 'copied-from-elsewhere.json')
    fs.copyFileSync(cache.keyOf('flat'), copy)
    const s2 = await startTestServer(cache.dir, { args: [copy] })
    const r = await s2.api(`/api/snapshot?file=${encodeURIComponent(copy)}`)
    expect(r.status).toBe(200)
    expect((await r.json()).version).toBe(2)
    const other = path.join(outside, 'other.json')
    fs.writeFileSync(other, '{}')
    expect((await s2.api(`/api/snapshot?file=${encodeURIComponent(other)}`)).status).toBe(403)
    await s2.close()
  })

  it('404s an indexed snapshot that has no file yet (scan in progress)', async () => {
    const index = readIndexSync(cache.dir)
    const key = path.join(cache.dir, 'nofile-apparent-1.json')
    index[key] = { root: '/r/nofile', mode: 'apparent', host: os.hostname(), pid: 1, in_progress: true, complete: false, started_epoch: 1 }
    writeIndex(cache.dir, index)
    expect((await srv.json(`/api/snapshot?file=${encodeURIComponent(key)}`)).status).toBe(404)
  })
})

describe('/api/ls path guard and listing', () => {
  let srv: TestServer
  let base: string
  let root: string
  let outside: string
  const ls = (p: string) => srv.json(`/api/ls?path=${encodeURIComponent(p)}`)

  beforeAll(async () => {
    base = fs.realpathSync(tmpDir('dirscan-ls-'))
    root = path.join(base, 'root')
    outside = path.join(base, 'outside')
    fs.mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true })
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret')
    fs.mkdirSync(path.join(base, 'root-evil')) // shares a name prefix with the root
    fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(5000))
    fs.writeFileSync(path.join(root, 'tiny.txt'), 'x')
    fs.writeFileSync(path.join(root, 'empty'), '')
    fs.symlinkSync(outside, path.join(root, 'escape'))
    fs.symlinkSync('tiny.txt', path.join(root, 'rel-link'))
    fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'inside-link'))
    fs.symlinkSync('/nonexistent', path.join(root, 'dangling'))
    fs.writeFileSync(path.join(root, 'sub', 'deep', 'f.txt'), 'hello')
    const cache = tmpDir('dirscan-cache-')
    writeIndex(cache, {
      [path.join(cache, 'root-apparent-1.json')]: { root, mode: 'apparent', host: os.hostname(), complete: true, in_progress: false },
    })
    srv = await startTestServer(cache)
  })
  afterAll(() => srv.close())

  it('lists a scan root with every entry, small files included, sorted by size desc', async () => {
    const { status, body } = await ls(root)
    expect(status).toBe(200)
    expect(body.path).toBe(root)
    expect(body.truncated).toBe(false)
    expect(body.total).toBe(body.entries.length)
    const names = body.entries.map((e: any) => e.name)
    expect(names).toEqual(expect.arrayContaining(['big.bin', 'tiny.txt', 'empty', 'sub', 'escape', 'rel-link', 'dangling']))
    const sizes = body.entries.map((e: any) => e.size)
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a))
    expect(names[0] === 'big.bin' || body.entries[0].size >= 5000).toBe(true)
    const byName = Object.fromEntries(body.entries.map((e: any) => [e.name, e]))
    expect(byName['big.bin']).toMatchObject({ type: 'file', size: 5000 })
    expect(byName['tiny.txt'].size).toBe(1)
    expect(byName.empty.size).toBe(0)
    expect(byName.sub.type).toBe('dir')
    expect(byName['rel-link']).toMatchObject({ type: 'symlink', target: 'tiny.txt' })
    expect(byName.dangling).toMatchObject({ type: 'symlink', target: '/nonexistent' })
    for (const e of body.entries) {
      expect(typeof e.blocks).toBe('number')
      expect(typeof e.mtime).toBe('number')
      expect(typeof e.mode).toBe('number')
      expect(e.uid).toBe(process.getuid?.())
    }
    expect(typeof body.listedAt).toBe('number')
  })

  it('lists subdirectories of a root', async () => {
    const { status, body } = await ls(path.join(root, 'sub', 'deep'))
    expect(status).toBe(200)
    expect(body.entries.map((e: any) => e.name)).toEqual(['f.txt'])
  })

  it('judges the resolved path, not the spelling: a detour through a symlink that lands back inside is fine', async () => {
    // escape -> outside, `..` -> base, then back down into root/sub (kernel semantics)
    const r = await ls(`${root}/escape/../root/sub`)
    expect(r.status).toBe(200)
    expect(r.body.path).toBe(path.join(root, 'sub'))
  })

  it('serves a symlink that stays inside the root', async () => {
    expect((await ls(path.join(root, 'inside-link'))).status).toBe(200)
  })

  const outsideCases: [string, () => string][] = [
    ['a dir outside every root', () => outside],
    ['the parent of a root', () => base],
    ['the filesystem root', () => '/'],
    ['/etc', () => '/etc'],
    ['a sibling that shares the root name as a prefix', () => path.join(base, 'root-evil')],
    ['.. climbing out of the root', () => `${root}/../outside`],
    ['.. in the middle that lands outside', () => `${root}/sub/../../outside`],
    ['a symlink pointing outside the root', () => path.join(root, 'escape')],
    ['below a symlink pointing outside', () => path.join(root, 'escape', 'secret.txt')],
    ['.. after a symlink that points outside', () => `${root}/escape/..`],
    ['a path that does not exist outside the roots (must not reveal 404)', () => path.join(base, 'no-such-dir')],
  ]
  for (const [label, p] of outsideCases) {
    it(`rejects ${label}`, async () => {
      const { status, body } = await ls(p())
      expect(status).toBe(403)
      expect(body.code).toBe('EOUTSIDE')
      expect(JSON.stringify(body)).not.toContain('secret')
    })
  }

  it('rejects relative paths, empty paths and NUL bytes with 400', async () => {
    for (const p of ['relative/path', '', '.', '~', `${root}/\0x`]) {
      const { status } = await ls(p)
      expect(status, JSON.stringify(p)).toBe(400)
    }
    expect((await srv.json('/api/ls')).status).toBe(400)
  })

  it('reports ENOENT for a missing path inside a root, and ENOTDIR for a file', async () => {
    const missing = await ls(path.join(root, 'nope'))
    expect(missing.status).toBe(404)
    expect(missing.body.code).toBe('ENOENT')
    const file = await ls(path.join(root, 'tiny.txt'))
    expect(file.status).toBe(400)
    expect(file.body.code).toBe('ENOTDIR')
  })

  it.skipIf(isRoot)('reports EACCES for an unreadable dir inside a root', async () => {
    const locked = path.join(root, 'locked')
    fs.mkdirSync(locked)
    fs.chmodSync(locked, 0)
    try {
      const { status, body } = await ls(locked)
      expect(status).toBe(403)
      expect(body.code).toBe('EACCES')
    } finally {
      fs.chmodSync(locked, 0o755)
    }
  })

  it('caps big directories at 5000 entries and says so', async () => {
    const dir = path.join(root, 'many')
    fs.mkdirSync(dir)
    for (let i = 0; i < 5100; i++) fs.writeFileSync(path.join(dir, `f${i}`), i === 77 ? 'abc' : '')
    const { status, body } = await ls(dir)
    expect(status).toBe(200)
    expect(body.truncated).toBe(true)
    expect(body.total).toBe(5100)
    expect(body.entries).toHaveLength(5000)
    expect(body.entries[0].name).toBe('f77') // largest first, so the cap drops the smallest
  })

  it('also serves a root passed on the command line that no scan has used yet', async () => {
    const extra = fs.realpathSync(tmpDir('dirscan-cli-root-'))
    fs.writeFileSync(path.join(extra, 'a.txt'), 'a')
    const s2 = await startTestServer(tmpDir('dirscan-cache-'), { args: [extra] })
    const r = await s2.json(`/api/ls?path=${encodeURIComponent(extra)}`)
    expect(r.status).toBe(200)
    expect((await s2.json(`/api/ls?path=${encodeURIComponent(outside)}`)).status).toBe(403)
    await s2.close()
  })

  it('follows the index: a root is allowed once a scan of it is listed, not before', async () => {
    const extra = fs.realpathSync(tmpDir('dirscan-late-root-'))
    expect((await ls(extra)).status).toBe(403)
    const idx = readIndexSync(srv.cacheDir)
    idx['/late.json'] = { root: extra, mode: 'apparent', host: 'h', complete: true, in_progress: false }
    writeIndex(srv.cacheDir, idx)
    expect((await ls(extra)).status).toBe(200)
  })
})

/** Read an SSE response incrementally. */
function collect(res: Response) {
  const messages: { event: string; data: string }[] = []
  const decoder = new TextDecoder()
  let buf = ''
  const done = (async () => {
    const reader = res.body!.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const cut = buf.lastIndexOf('\n\n')
      if (cut >= 0) {
        messages.push(...parseSse(buf.slice(0, cut + 2)))
        buf = buf.slice(cut + 2)
      }
    }
  })()
  const lines = () => messages.filter((m) => m.event === 'message').flatMap((m) => (JSON.parse(m.data) as LiveEvent[]))
  return { messages, done, lines }
}

describe('/api/live', () => {
  let cache: ReturnType<typeof makeCache>
  let srv: TestServer
  const scanners: ChildProcess[] = []
  beforeAll(async () => {
    cache = makeCache()
    srv = await startTestServer(cache.dir)
  })
  afterAll(async () => {
    scanners.forEach((s) => s.kill())
    await srv.close()
  })

  const live = (key: string) => srv.api(`/api/live?file=${encodeURIComponent(key)}`)

  /** register a fake running scan whose events file we control */
  function registerRunning(name: string, pid: number, host = os.hostname()) {
    const key = path.join(cache.dir, `${name}-apparent-1.json`)
    const index = readIndexSync(cache.dir)
    index[key] = { root: `/r/${name}`, mode: 'apparent', host, pid, in_progress: true, complete: false, started_epoch: 1 }
    writeIndex(cache.dir, index)
    return eventsPathFor(key)
  }

  for (const f of fixtures) {
    it(`${f.name}: a finished scan streams from offset 0 and closes after "e"; reducer output == snapshot`, async () => {
      const res = await live(path.join(cache.dir, path.basename(f.snapshotFile)))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      const c = collect(res)
      await c.done // server closed the stream by itself
      const lines = c.lines()
      expect(lines).toEqual(f.events)
      expect(lines[lines.length - 1][0]).toBe('e')
      const st = createLiveState()
      applyEvents(st, lines)
      expect(st.tree.n).toBe(f.snapshot.tree.n)
      expect(st.largest).toEqual(f.snapshot.largest)
    })
  }

  it('batches at most 5000 lines per message', () => {
    const lines = Array.from({ length: 12_345 }, (_, i) => `["n",${i},0,"x"]`)
    const out = [...batches(lines)].map((b) => JSON.parse(b).length)
    expect(out).toEqual([5000, 5000, 2345])
    expect([...batches(['bad', '["ok"]', '{"no":1}'])]).toEqual(['[["ok"]]'])
  })

  it('catches up on a scan that is already half done, then follows it to the end', async () => {
    const f = fixtures.find((x) => x.name === 'small')!
    const alive = fakeScanner()
    scanners.push(alive)
    const eventsFile = registerRunning('follow', alive.pid!)
    const text = f.eventBytes.toString('utf8')
    const cut = Math.floor(text.length * 0.4)
    const mid = text.indexOf('\n', cut) + 8 // ends in the middle of a line
    fs.writeFileSync(eventsFile, text.slice(0, mid))

    const c = collect(await live(path.join(cache.dir, 'follow-apparent-1.json')))
    await waitFor(() => c.lines().length > 0, 'catch-up lines')
    const first = c.lines().length
    expect(first).toBeGreaterThan(5)
    // the half-written last line has not been sent
    expect(c.lines().every((l) => Array.isArray(l))).toBe(true)

    // the rest arrives in uneven pieces (some split mid-line), as the scanner flushes
    let at = mid
    const rnd = [37, 400, 3, 1500, 90]
    for (let i = 0; at < text.length; i++) {
      const next = Math.min(text.length, at + rnd[i % rnd.length])
      fs.appendFileSync(eventsFile, text.slice(at, next))
      at = next
      await sleep(i % 3 === 0 ? 120 : 5)
    }
    await c.done
    expect(c.lines()).toEqual(f.events)
  })

  it('follows a scan that restarts (truncated file, new header)', async () => {
    const small = fixtures.find((x) => x.name === 'small')!
    const flat = fixtures.find((x) => x.name === 'flat')!
    const alive = fakeScanner()
    scanners.push(alive)
    const eventsFile = registerRunning('restart', alive.pid!)
    const half = small.eventBytes.toString('utf8').split('\n').slice(0, 60).join('\n') + '\n'
    fs.writeFileSync(eventsFile, half)
    const c = collect(await live(path.join(cache.dir, 'restart-apparent-1.json')))
    await waitFor(() => c.lines().length >= 60, 'first scan lines')

    fs.truncateSync(eventsFile, 0)
    await sleep(350) // let a poll see the empty file
    fs.writeFileSync(eventsFile, flat.eventBytes)
    await c.done
    const lines = c.lines()
    expect(lines.filter((l) => l[0] === 'h')).toHaveLength(2)
    const st = createLiveState()
    applyEvents(st, lines)
    expect(st.tree.n).toBe(flat.snapshot.tree.n)
    expect(st.header?.root).toBe(flat.snapshot.meta.root)
  })

  it('closes with a "closed" event when the scanner was killed (abandoned) before writing "e"', async () => {
    const f = fixtures.find((x) => x.name === 'small')!
    const eventsFile = registerRunning('dead', deadPid())
    fs.writeFileSync(eventsFile, f.eventBytes.toString('utf8').split('\n').slice(0, 40).join('\n') + '\n')
    const c = collect(await live(path.join(cache.dir, 'dead-apparent-1.json')))
    await c.done
    expect(c.lines()).toHaveLength(40)
    const closed = c.messages.find((m) => m.event === 'closed')!
    expect(JSON.parse(closed.data).state).toBe('abandoned')
  })

  it('refuses to tail a scan from another host', async () => {
    registerRunning('elsewhere', 1, 'other-node')
    const { status, body } = await srv.json(`/api/live?file=${encodeURIComponent(path.join(cache.dir, 'elsewhere-apparent-1.json'))}`)
    expect(status).toBe(409)
    expect(body.code).toBe('EREMOTE')
  })

  it('404s unknown scans and refuses arbitrary files', async () => {
    expect((await srv.json('/api/live?file=/etc/passwd')).status).toBe(404)
    expect((await srv.json('/api/live')).status).toBe(404)
  })

  it('sends keepalive comments and survives a client disconnect', async () => {
    const alive = fakeScanner()
    scanners.push(alive)
    const eventsFile = registerRunning('quiet', alive.pid!)
    fs.writeFileSync(eventsFile, '["h",{"pid":1}]\n')
    const ac = new AbortController()
    const res = await srv.api(`/api/live?file=${encodeURIComponent(path.join(cache.dir, 'quiet-apparent-1.json'))}`, { signal: ac.signal })
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain(': connected')
    ac.abort()
    await sleep(100)
    // the server keeps working
    expect((await srv.json('/api/info')).status).toBe(200)
  })
})

describe('POST /api/scan and /api/stop (real dirscan.py)', () => {
  let cache: string
  let srv: TestServer
  beforeAll(async () => {
    cache = tmpDir('dirscan-cache-')
    srv = await startTestServer(cache)
  })
  afterAll(() => srv.close())

  const post = (p: string, body: unknown) =>
    srv.json(p, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

  it('starts a scan, returns its snapshot key, and the snapshot appears', async () => {
    const root = fs.realpathSync(tmpDir('dirscan-tree-'))
    fs.mkdirSync(path.join(root, 'a'))
    fs.writeFileSync(path.join(root, 'a', 'x.bin'), Buffer.alloc(1234))
    fs.writeFileSync(path.join(root, 'y.txt'), 'hello')
    const { status, body } = await post('/api/scan', { root })
    expect(status).toBe(200)
    expect(body.file).toMatch(/\.json$/)
    expect(path.dirname(body.file)).toBe(cache)
    const row = await waitFor(async () => {
      const { body: scans } = await srv.json('/api/scans')
      return scans.find((s: any) => s.file === body.file && s.state === 'done')
    }, 'scan to finish')
    expect(row.bytes).toBe(1239)
    const snap = parseSnapshot(fs.readFileSync(body.file, 'utf8'))
    expect(snap.meta.root).toBe(root)
    expect(snap.tree.totalBytes[0]).toBe(1239)
  })

  it('--du scans are a separate key from apparent ones', async () => {
    const root = fs.realpathSync(tmpDir('dirscan-tree-'))
    fs.writeFileSync(path.join(root, 'f'), 'x')
    const a = await post('/api/scan', { root })
    const d = await post('/api/scan', { root, du: true })
    expect(a.body.file).not.toBe(d.body.file)
    expect(path.basename(d.body.file)).toContain('-du-')
  })

  it('validates the root', async () => {
    expect((await post('/api/scan', { root: 'relative' })).status).toBe(400)
    expect((await post('/api/scan', {})).status).toBe(400)
    expect((await post('/api/scan', { root: '/definitely/not/here' })).status).toBe(400)
    const file = path.join(tmpDir(), 'f')
    fs.writeFileSync(file, '')
    expect((await post('/api/scan', { root: file })).body.code).toBe('ENOTDIR')
  })

  it('refuses a second scan of the same root and mode while one is running', async () => {
    const root = fs.realpathSync(tmpDir('dirscan-tree-'))
    const alive = fakeScanner()
    try {
      const idx = readIndexSync(cache)
      const key = path.join(cache, 'dup-apparent-1.json')
      idx[key] = { root, mode: 'apparent', host: os.hostname(), pid: alive.pid, in_progress: true, complete: false, started_epoch: 1 }
      writeIndex(cache, idx)
      const r = await post('/api/scan', { root })
      expect(r.status).toBe(409)
      expect(r.body.code).toBe('EALREADY')
      expect(r.body.file).toBe(key)
      // a different mode of the same root is a different scan
      expect((await post('/api/scan', { root, du: true })).status).toBe(200)
    } finally {
      alive.kill()
    }
  })

  it('rejects garbage bodies', async () => {
    const r = await srv.json('/api/scan', { method: 'POST', body: '{nope' })
    expect(r.status).toBe(400)
  })

  it('Stop makes the scanner write a partial snapshot, state "partial"', async () => {
    const root = fs.realpathSync(tmpDir('dirscan-tree-'))
    for (let d = 0; d < 400; d++) {
      const dir = path.join(root, `d${d}`)
      fs.mkdirSync(dir)
      for (let f = 0; f < 200; f++) fs.closeSync(fs.openSync(path.join(dir, `f${f}`), 'w'))
    }
    const { body } = await post('/api/scan', { root })
    const running = await srv.json('/api/scans')
    expect(running.body.find((s: any) => s.file === body.file)).toMatchObject({ state: 'running', managed: true })
    const stop = await post('/api/stop', { file: body.file })
    expect(stop.status).toBe(200)
    const row = await waitFor(async () => {
      const { body: scans } = await srv.json('/api/scans')
      const s = scans.find((x: any) => x.file === body.file)
      return s && s.state !== 'running' ? s : null
    }, 'scan to stop')
    expect(row.state).toBe('partial')
    const snap = parseSnapshot(fs.readFileSync(body.file, 'utf8'))
    expect(snap.meta.complete).toBe(false)
    // and the event stream ends with an "e" saying so
    const lines = fs.readFileSync(eventsPathFor(body.file), 'utf8').trim().split('\n')
    expect(JSON.parse(lines[lines.length - 1])).toMatchObject(['e', { complete: false }])
    // it is no longer ours to stop
    expect((await post('/api/stop', { file: body.file })).status).toBe(409)
  })

  it('only stops scans this server started', async () => {
    const alive = fakeScanner()
    try {
      const key = path.join(cache, 'foreign-apparent-1.json')
      const idx = readIndexSync(cache)
      idx[key] = { root: '/r/foreign', mode: 'apparent', host: os.hostname(), pid: alive.pid, in_progress: true, complete: false, started_epoch: 1 }
      writeIndex(cache, idx)
      const r = await post('/api/stop', { file: key })
      expect(r.status).toBe(409)
      expect(r.body.code).toBe('ENOTMANAGED')
      expect(alive.exitCode).toBeNull()
      await sleep(50)
      expect(alive.killed).toBe(false)
      expect((await post('/api/stop', { file: '/etc/passwd' })).status).toBe(409)
      expect((await post('/api/stop', {})).status).toBe(409)
    } finally {
      alive.kill()
    }
  })

  it('reports a clear error when the scanner cannot start', async () => {
    const s2 = await startTestServer(tmpDir('dirscan-cache-'), { args: ['--python', '/no/such/python'] })
    const r = await s2.json('/api/scan', { method: 'POST', body: JSON.stringify({ root: os.tmpdir() }) })
    expect(r.status).toBe(500)
    expect(r.body.code).toBe('ESPAWN')
    await s2.close()
  })
})

describe('static files', () => {
  it('serves the built UI without a token, with CSP, and never outside dist/', async () => {
    const dist = fs.realpathSync(tmpDir('dirscan-dist-'))
    fs.mkdirSync(path.join(dist, 'assets'))
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>x</title>')
    fs.writeFileSync(path.join(dist, 'assets', 'a-123.js'), 'console.log(1)')
    fs.writeFileSync(path.join(path.dirname(dist), 'dirscan-secret.txt'), 'nope')
    const srv = await startTestServer(tmpDir('dirscan-cache-'), { distDir: dist })
    try {
      const home = await fetch(srv.base + '/')
      expect(home.status).toBe(200)
      expect(home.headers.get('content-security-policy')).toContain("default-src 'self'")
      expect(home.headers.get('cache-control')).toBe('no-cache')
      const js = await fetch(srv.base + '/assets/a-123.js')
      expect(js.headers.get('content-type')).toContain('javascript')
      expect(js.headers.get('cache-control')).toContain('immutable')
      for (const p of ['/..%2fdirscan-secret.txt', '/%2e%2e/dirscan-secret.txt', '/assets/..%2f..%2fdirscan-secret.txt', '/nope.js']) {
        const r = await fetch(srv.base + p)
        expect([403, 404], p).toContain(r.status)
        expect(await r.text()).not.toContain('nope\n')
      }
    } finally {
      await srv.close()
    }
  })

  it('says how to build when dist/ is missing', async () => {
    const srv = await startTestServer(tmpDir('dirscan-cache-'))
    const r = await fetch(srv.base + '/')
    expect(r.status).toBe(503)
    expect(await r.text()).toContain('npm run build')
    await srv.close()
  })
})

describe('CLI', () => {
  it('only binds loopback addresses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('0.0.0.0')).toBe(false)
    expect(isLoopback('10.1.2.3')).toBe(false)
    expect(() => parseCli(['--host', '0.0.0.0'], REPO_ROOT)).toThrow(/loopback/)
    expect(() => parseCli(['--port', 'abc'], REPO_ROOT)).toThrow(/--port/)
    expect(() => parseCli(['--scan'], REPO_ROOT)).toThrow(/--scan needs/)
    expect(() => parseCli(['a', 'b'], REPO_ROOT)).toThrow(/at most one/)
    const o = parseCli(['/some/dir', '--scan', '--du', '--no-open', '--port', '5000'], REPO_ROOT)
    expect(o).toMatchObject({ target: '/some/dir', scan: true, du: true, open: false, port: 5000, portFixed: true, host: '127.0.0.1' })
    expect(o.scanner).toBe(path.join(REPO_ROOT, 'dirscan.py'))
  })

  describe('target resolution', () => {
    const cfg = (target: string, cacheDir: string, extra = {}) => ({ target, scan: false, du: false, cacheDir, ...extra })

    it('a snapshot file opens that file and registers its root', async () => {
      const cache = makeCache()
      const file = cache.keyOf('small')
      const t = await resolveTarget(cfg(file, cache.dir), null as any)
      expect(t.route).toBe(`#/scan?file=${encodeURIComponent(file)}`)
      expect(t.cliFiles).toEqual([file])
      expect(t.cliRoots).toEqual([fixtures.find((f) => f.name === 'small')!.snapshot.meta.root])
    })

    it('a dir prefers its running scan over a newer snapshot, else the newest snapshot', async () => {
      const cache = makeCache()
      const root = fixtures.find((f) => f.name === 'small')!.snapshot.meta.root
      let t = await resolveTarget(cfg(root, cache.dir), null as any)
      expect(t.route).toBe(`#/scan?file=${encodeURIComponent(cache.keyOf('small'))}`) // apparent beats du by default
      t = await resolveTarget(cfg(root, cache.dir, { du: true }), null as any)
      expect(decodeURIComponent(t.route)).toContain('small-du-')

      const alive = fakeScanner()
      try {
        const idx = readIndexSync(cache.dir)
        const key = path.join(cache.dir, 'live-small.json')
        idx[key] = { root, mode: 'apparent', host: os.hostname(), pid: alive.pid, in_progress: true, complete: false, started_epoch: 1 }
        writeIndex(cache.dir, idx)
        t = await resolveTarget(cfg(root, cache.dir), null as any)
        expect(t.route).toBe(`#/scan?file=${encodeURIComponent(key)}`)
      } finally {
        alive.kill()
      }
    })

    it('a dir nobody scanned yet falls back to the dashboard but is still an allowed root', async () => {
      const cache = makeCache()
      const dir = fs.realpathSync(tmpDir('dirscan-unscanned-'))
      const t = await resolveTarget(cfg(dir, cache.dir), null as any)
      expect(t.route).toBe('')
      expect(t.cliRoots).toEqual([dir])
      expect(t.notes[0]).toContain('--scan')
    })
  })
})

describe('Tailer', () => {
  it('detects a restart even when the new scan regrew past the old offset between polls', async () => {
    const { Tailer } = await import('../server/tail.js')
    const dir = tmpDir()
    const file = path.join(dir, 'e.ndjson')
    const header = (pid: number) => `["h",{"pid":${pid},"root":"/r"}]\n`
    const body = (n: number) => Array.from({ length: n }, (_, i) => `["n",${i},0,"d${i}"]\n`).join('')
    fs.writeFileSync(file, header(111) + body(5))
    const t = new Tailer(file)
    const first = await t.read()
    expect(first.lines).toHaveLength(6)
    expect(first.reset).toBe(false)

    // new scan: truncated, and by our next poll already longer than the old file
    fs.writeFileSync(file, header(222) + body(50))
    const second = await t.read()
    expect(second.reset).toBe(true)
    expect(second.lines[0]).toContain('"pid":222')
    expect(second.lines).toHaveLength(51)
  })

  it('reports a missing file, and waits for the file to appear', async () => {
    const { Tailer } = await import('../server/tail.js')
    const file = path.join(tmpDir(), 'later.ndjson')
    const t = new Tailer(file)
    expect(await t.read()).toMatchObject({ missing: true, lines: [], eof: true })
    fs.writeFileSync(file, '["h",{}]\n')
    expect((await t.read()).lines).toEqual(['["h",{}]'])
  })

  it('does not mistake a header that is still being written for a restart', async () => {
    const { Tailer } = await import('../server/tail.js')
    const file = path.join(tmpDir(), 'e.ndjson')
    fs.writeFileSync(file, '["h",{"pid":1,')
    const t = new Tailer(file)
    expect((await t.read()).lines).toEqual([])
    fs.appendFileSync(file, '"root":"/r"}]\n["n",0,-1,"r"]\n')
    const r = await t.read()
    expect(r.reset).toBe(false)
    expect(r.lines).toEqual(['["h",{"pid":1,"root":"/r"}]', '["n",0,-1,"r"]'])
  })

  it('reads big files in bounded chunks', async () => {
    const { Tailer } = await import('../server/tail.js')
    const file = path.join(tmpDir(), 'e.ndjson')
    const lines = Array.from({ length: 3000 }, (_, i) => `["n",${i},0,"dir${i}"]`)
    fs.writeFileSync(file, lines.join('\n') + '\n')
    const t = new Tailer(file, { readSize: 4096 })
    const got: string[] = []
    for (let r = await t.read(); ; r = await t.read()) {
      got.push(...r.lines)
      if (r.eof) break
    }
    expect(got).toEqual(lines)
  })
})


describe('review regressions (server)', () => {
  /** raw HTTP/1.1 request, so odd request targets reach the server untouched */
  const raw = (port: number, target: string, extra = '') =>
    new Promise<string>((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${extra}\r\n`))
      let out = ''
      sock.on('data', (d) => (out += d))
      sock.on('close', () => resolve(out))
      sock.on('error', () => resolve(out || 'ERROR'))
    })

  it('a malformed request target answers 400 instead of killing the server', async () => {
    const srv = await startTestServer(tmpDir('dirscan-cache-'))
    try {
      const port = Number(new URL(srv.base).port)
      for (const t of ['//', '///x', 'http://', '/%']) {
        const r = await raw(port, t)
        expect(r, t).toMatch(/^HTTP\/1\.1 (400|403|404|503)/)
      }
      expect((await srv.json('/api/info')).status).toBe(200) // still up
    } finally {
      await srv.close()
    }
  })

  it('aborted static downloads do not leak file descriptors', async () => {
    const dist = fs.realpathSync(tmpDir('dirscan-dist-'))
    fs.mkdirSync(path.join(dist, 'assets'))
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html>')
    fs.writeFileSync(path.join(dist, 'assets', 'big.js'), Buffer.alloc(20 * 1024 * 1024))
    const srv = await startTestServer(tmpDir('dirscan-cache-'), { distDir: dist })
    try {
      const fds = () => fs.readdirSync('/proc/self/fd').length
      const before = fds()
      for (let i = 0; i < 20; i++) {
        const ac = new AbortController()
        const res = await fetch(srv.base + '/assets/big.js', { signal: ac.signal })
        await res.body!.getReader().read()
        ac.abort()
      }
      await sleep(500)
      expect(fds() - before).toBeLessThan(5)
    } finally {
      await srv.close()
    }
  })

  it.skipIf(isRoot)('/api/ls gives no existence oracle through an in-root symlink that points outside', async () => {
    const base = fs.realpathSync(tmpDir('dirscan-oracle-'))
    const root = path.join(base, 'root')
    const outside = path.join(base, 'outside')
    fs.mkdirSync(root)
    fs.mkdirSync(path.join(outside, 'adir'), { recursive: true })
    fs.writeFileSync(path.join(outside, 'afile'), 'x')
    fs.symlinkSync(outside, path.join(root, 'link'))
    const cache = tmpDir('dirscan-cache-')
    writeIndex(cache, { [path.join(cache, 'r-apparent-1.json')]: { root, mode: 'apparent', host: 'h', complete: true, in_progress: false } })
    const srv = await startTestServer(cache)
    try {
      const ls = (p: string) => srv.json(`/api/ls?path=${encodeURIComponent(p)}`)
      const answers = await Promise.all([
        `${root}/link/nonexistent`, `${root}/link/afile`, `${root}/link/afile/x`, `${root}/link/adir`,
        `${root}/link/../nonexistent`, `${root}/link/../outside/afile/x`,
      ].map(async (p) => [p, (await ls(p)).body.code] as const))
      for (const [p, code] of answers) expect(code, p).toBe('EOUTSIDE')
      // genuinely missing paths inside the root are still reported as such
      expect((await ls(`${root}/nope`)).body.code).toBe('ENOENT')
    } finally {
      await srv.close()
    }
  })

  it('rejects a JSON null / array body with 400, and honours gzip;q=0', async () => {
    const cache = makeCache()
    const srv = await startTestServer(cache.dir)
    try {
      const post = (body: string) => srv.json('/api/scan', { method: 'POST', body })
      expect((await post('null')).status).toBe(400)
      expect((await post('[1]')).status).toBe(400)
      const key = cache.keyOf('flat')
      const r = await srv.api(`/api/snapshot?file=${encodeURIComponent(key)}`, { headers: { 'accept-encoding': 'gzip;q=0, identity' } })
      expect(r.headers.get('content-encoding')).toBeNull()
    } finally {
      await srv.close()
    }
  })

  it('a second Stop for the same scan does not signal it again (a repeat SIGTERM can destroy the snapshot)', async () => {
    const cache = tmpDir('dirscan-cache-')
    const srv = await startTestServer(cache)
    try {
      const root = fs.realpathSync(tmpDir('dirscan-tree-'))
      for (let d = 0; d < 300; d++) {
        const dir = path.join(root, `d${d}`)
        fs.mkdirSync(dir)
        for (let f = 0; f < 200; f++) fs.closeSync(fs.openSync(path.join(dir, `f${f}`), 'w'))
      }
      const { body } = await srv.json('/api/scan', { method: 'POST', body: JSON.stringify({ root }) })
      const child = (srv.scans as any).children.get(body.file) as ChildProcess
      const signals: string[] = []
      const kill = child.kill.bind(child)
      child.kill = ((sig: NodeJS.Signals) => (signals.push(String(sig)), kill(sig))) as typeof child.kill
      const post = () => srv.json('/api/stop', { method: 'POST', body: JSON.stringify({ file: body.file }) })
      const [a, b, c] = await Promise.all([post(), post(), post()])
      expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
      expect(signals).toEqual(['SIGTERM']) // one signal, however many clicks
      const snap = await waitFor(() => {
        try {
          const s = JSON.parse(fs.readFileSync(body.file, 'utf8'))
          return s.complete === false ? s : null
        } catch {
          return null
        }
      }, 'a partial snapshot')
      expect(snap.complete).toBe(false)
    } finally {
      await srv.close()
    }
  })

  it('a recycled pid owned by another program is not "running" even when kill(pid,0) says EPERM', () => {
    if (!fs.existsSync('/proc/1/cmdline')) return
    let cmd = ''
    try { cmd = fs.readFileSync('/proc/1/cmdline', 'latin1') } catch { return } // hidden: nothing to check
    if (!cmd || /python|dirscan/i.test(cmd)) return
    expect(deriveState({ in_progress: true, host: os.hostname(), pid: 1 })).toBe('abandoned')
  })
})
