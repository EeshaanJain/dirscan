import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ScanStore, NOTIFY_MS, type ScanView } from '@/lib/scanStore'
import { applyEvents, createLiveState, type LiveEvent } from '@/lib/events'
import { F_COMPLETE } from '@/lib/tree'
import { loadFixtures, mulberry32, type Fixture } from './fixtures'

const fixtures = loadFixtures()
const byName = (n: string) => fixtures.find((f) => f.name === n)!

const enc = new TextEncoder()

/** An SSE body for `events`: 5000-line batches, delivered in odd-sized network chunks. */
function sseBody(events: LiveEvent[], opts: { seed?: number; tail?: string; dropAfterBytes?: number } = {}) {
  const rnd = mulberry32(opts.seed ?? 1)
  let text = ': connected\n\n'
  for (let i = 0; i < events.length; i += 5000) text += `data: ${JSON.stringify(events.slice(i, i + 5000))}\n\n`
  text += opts.tail ?? ''
  const bytes = enc.encode(text)
  let at = 0
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (at >= bytes.length) return ctrl.close()
      const n = Math.min(bytes.length - at, 1 + Math.floor(rnd() * 3000))
      ctrl.enqueue(bytes.subarray(at, at + n))
      at += n
      if (opts.dropAfterBytes !== undefined && at >= opts.dropAfterBytes) ctrl.error(new TypeError('network error'))
      await new Promise((r) => setTimeout(r, 0))
    },
  })
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function fetcherFor(f: Fixture, handlers: { live?: () => Response; snapshot?: () => Response } = {}) {
  const calls: string[] = []
  const fn = async (path: string) => {
    calls.push(path)
    if (path.startsWith('/api/live')) return handlers.live ? handlers.live() : new Response(sseBody(f.events))
    if (path.startsWith('/api/snapshot')) {
      return handlers.snapshot ? handlers.snapshot() : new Response(fs.readFileSync(f.snapshotFile, 'utf8'))
    }
    return json({ error: 'unexpected', code: 'ENOENT' }, 404)
  }
  return { fn, calls }
}

async function until(store: ScanStore, pred: (v: ScanView) => boolean, ms = 8000): Promise<ScanView> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred(store.getSnapshot())) return store.getSnapshot()
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out; phase=${store.getSnapshot().phase} error=${store.getSnapshot().error}`)
}

function expectSameTree(a: ScanView, f: Fixture) {
  const t = a.tree!
  const s = f.snapshot.tree
  expect(t.n).toBe(s.n)
  for (let i = 0; i < s.n; i++) {
    if (t.parent[i] !== s.parent[i] || t.names[i] !== s.names[i] || t.totalBytes[i] !== s.totalBytes[i]) {
      throw new Error(`dir ${i} differs from the snapshot`)
    }
  }
}

describe('ScanStore: snapshot mode', () => {
  it('loads and indexes a snapshot', async () => {
    const f = byName('small')
    const store = new ScanStore({ fetcher: fetcherFor(f).fn })
    expect(store.getSnapshot().phase).toBe('loading')
    store.open('k', 'snapshot')
    const v = await until(store, (x) => x.phase === 'snapshot')
    expect(v.root).toBe(f.snapshot.meta.root)
    expect(v.mode).toBe('apparent')
    expect(v.complete).toBe(true)
    expect(v.totals).toEqual(f.snapshot.meta.totals)
    expect(v.largest).toEqual(f.snapshot.largest)
    expectSameTree(v, f)
  })

  it('shows a partial snapshot as complete=false', async () => {
    const v = await (async () => {
      const store = new ScanStore({ fetcher: fetcherFor(byName('big')).fn })
      store.open('k', 'snapshot')
      return until(store, (x) => x.phase === 'snapshot')
    })()
    expect(v.complete).toBe(false)
    expect(v.tree!.isComplete(0)).toBe(false)
  })

  it('reports a missing snapshot and server errors', async () => {
    const f = byName('small')
    let store = new ScanStore({ fetcher: fetcherFor(f, { snapshot: () => json({ error: 'x', code: 'ENOENT' }, 404) }).fn })
    store.open('k', 'snapshot')
    let v = await until(store, (x) => x.phase === 'error')
    expect(v.error).toMatch(/No snapshot file/)
    store = new ScanStore({ fetcher: fetcherFor(f, { snapshot: () => json({ error: 'missing or wrong token', code: 'ETOKEN' }, 403) }).fn })
    store.open('k', 'snapshot')
    v = await until(store, (x) => x.phase === 'error')
    expect(v.error).toBe('missing or wrong token')
    store = new ScanStore({ fetcher: fetcherFor(f, { snapshot: () => new Response('{"version":9,"dirs":[]}') }).fn })
    store.open('k', 'snapshot')
    expect((await until(store, (x) => x.phase === 'error')).error).toMatch(/version 9/)
  })
})

describe('ScanStore: live mode', () => {
  for (const name of ['small', 'unreadable', 'big']) {
    it(`${name}: follows the stream, then switches to the snapshot at "e" (same dir ids, so the position survives)`, async () => {
      const f = byName(name)
      const { fn, calls } = fetcherFor(f)
      const store = new ScanStore({ fetcher: fn })
      const phases: string[] = []
      store.subscribe(() => {
        const p = store.getSnapshot().phase
        if (phases[phases.length - 1] !== p) phases.push(p)
      })
      store.open('k', 'live')
      const v = await until(store, (x) => x.phase === 'snapshot')
      expect(phases).toContain('live')
      expect(phases.indexOf('live')).toBeLessThan(phases.indexOf('snapshot'))
      expect(calls[0]).toContain('/api/live')
      expect(calls[calls.length - 1]).toContain('/api/snapshot')
      expect(v.complete).toBe(f.snapshot.meta.complete)
      expectSameTree(v, f) // authoritative: includes the in-flight dir of an interrupted scan
    })
  }

  it('applies every event (the live tree matches the reducer run directly) before swapping', async () => {
    const f = byName('small')
    // snapshot never arrives, so the store stays on the live tree
    const { fn } = fetcherFor(f, { snapshot: () => new Response(new ReadableStream({ start() {} })) })
    const store = new ScanStore({ fetcher: fn })
    store.open('k', 'live')
    const v = await until(store, (x) => x.phase === 'ended')
    const ref = createLiveState()
    applyEvents(ref, f.events)
    expect(v.eventsApplied).toBe(f.events.length)
    expect(v.tree!.n).toBe(ref.tree.n)
    expect(Array.from(v.tree!.totalBytes.subarray(0, ref.tree.n))).toEqual(Array.from(ref.tree.totalBytes.subarray(0, ref.tree.n)))
    expect(v.progress).toEqual(ref.progress)
    expect(v.complete).toBe(true)
    store.close()
  })

  it('exposes live progress and header while running (no "e" yet)', async () => {
    const f = byName('small')
    const partial = f.events.slice(0, 60)
    const { fn } = fetcherFor(f, { live: () => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(`data: ${JSON.stringify(partial)}\n\n`)) } })) })
    const store = new ScanStore({ fetcher: fn })
    store.open('k', 'live')
    const v = await until(store, (x) => x.phase === 'live' && x.eventsApplied === 60)
    expect(v.root).toBe(f.snapshot.meta.root)
    expect(v.host).toBe(f.snapshot.meta.host)
    expect(v.mode).toBe('apparent')
    expect(v.complete).toBeNull()
    expect(v.tree!.n).toBeGreaterThan(5)
    store.close()
  })

  it('a stream that closes without "e" (scanner killed) ends as stalled and keeps the partial tree', async () => {
    const f = byName('small')
    const cut = f.events.slice(0, 120)
    const { fn, calls } = fetcherFor(f, { live: () => new Response(sseBody(cut, { tail: 'event: closed\ndata: {"state":"abandoned"}\n\n' })) })
    const store = new ScanStore({ fetcher: fn })
    store.open('k', 'live')
    const v = await until(store, (x) => x.phase === 'stalled')
    expect(v.closedState).toBe('abandoned')
    expect(v.tree!.n).toBeGreaterThan(5)
    expect(v.eventsApplied).toBe(120)
    expect(calls.some((c) => c.includes('/api/snapshot'))).toBe(false)
  })

  it('reconnects after a dropped connection; the replay starts with "h" so state resets cleanly', async () => {
    const f = byName('small')
    let attempt = 0
    const { fn } = fetcherFor(f, {
      live: () => new Response(attempt++ === 0 ? sseBody(f.events, { dropAfterBytes: 3000 }) : sseBody(f.events)),
    })
    const store = new ScanStore({ fetcher: fn })
    store.open('k', 'live')
    const v = await until(store, (x) => x.phase === 'snapshot', 10_000)
    expect(attempt).toBe(2)
    expectSameTree(v, f)
  })

  it('does not retry when the server refuses (403 / 404 / 409)', async () => {
    const f = byName('small')
    let n = 0
    const { fn } = fetcherFor(f, { live: () => (n++, json({ error: 'scan is running on other-node', code: 'EREMOTE' }, 409)) })
    const store = new ScanStore({ fetcher: fn })
    store.open('k', 'live')
    const v = await until(store, (x) => x.phase === 'error')
    expect(v.error).toContain('other-node')
    await new Promise((r) => setTimeout(r, 700))
    expect(n).toBe(1)
  })

  it('close() stops everything: no more notifications after it', async () => {
    const f = byName('big')
    const store = new ScanStore({ fetcher: fetcherFor(f).fn })
    let calls = 0
    store.subscribe(() => calls++)
    store.open('k', 'live')
    await until(store, (x) => x.eventsApplied > 0)
    store.close()
    const at = calls
    await new Promise((r) => setTimeout(r, 400))
    expect(calls).toBe(at)
  })

  it('switching scans discards the previous one', async () => {
    const small = byName('small')
    const flat = byName('flat')
    const store = new ScanStore({
      fetcher: async (path) => {
        const f = path.includes('small') ? small : flat
        if (path.startsWith('/api/live')) return new Response(sseBody(f.events))
        return new Response(fs.readFileSync(f.snapshotFile, 'utf8'))
      },
    })
    store.open('small', 'live')
    store.open('flat', 'live')
    const v = await until(store, (x) => x.phase === 'snapshot')
    expectSameTree(v, flat)
  })
})

describe('ScanStore: keeping the UI responsive', () => {
  /** A synthetic scan of `dirs` dirs: n + s events like the real scanner emits. */
  function bigStream(dirs: number): LiveEvent[] {
    const evs: LiveEvent[] = [['h', { version: 2, root: '/x', host: 'h', mode: 'apparent', pid: 1, started_epoch: 1, cache_file: null }], ['n', 0, -1, 'x']]
    for (let i = 1; i < dirs; i++) evs.push(['n', i, Math.floor(i / 3), `d${i}`])
    for (let i = 0; i < dirs; i++) evs.push(['s', i, i % 1000, 1, 2])
    return evs
  }

  it('applies a big backlog in short slices and notifies at most every NOTIFY_MS', async () => {
    const evs = bigStream(100_000) // 200k events
    let notifications = 0
    const slices: number[] = []
    let sliceStart = 0
    const store = new ScanStore({
      fetcher: async () => new Response(sseBody(evs, { seed: 3 })),
      yieldFn: (cb) => void setTimeout(() => {
        sliceStart = performance.now()
        cb()
        slices.push(performance.now() - sliceStart)
      }, 0),
    })
    const t0 = performance.now()
    store.subscribe(() => notifications++)
    store.open('k', 'live')
    const v = await until(store, (x) => x.eventsApplied >= evs.length - 1 && x.tree !== null && x.tree.isComplete(0), 20_000)
    const elapsed = performance.now() - t0
    expect(v.tree!.n).toBe(100_000)
    expect(v.tree!.totalFiles[0]).toBe(100_000)
    // never one long block: each slice stays near its 8ms budget (generous bound for CI noise)
    expect(slices.length).toBeGreaterThan(5)
    expect(Math.max(...slices)).toBeLessThan(60)
    // notifications are throttled
    expect(notifications).toBeLessThanOrEqual(Math.ceil(elapsed / NOTIFY_MS) + 3)
    store.close()
  })

  it('ingests well over 10k events per second', async () => {
    const evs = bigStream(60_000) // 120k events
    const store = new ScanStore({ fetcher: async () => new Response(sseBody(evs, { seed: 4 })) })
    store.open('k', 'live')
    const t0 = performance.now()
    await until(store, (x) => x.eventsApplied >= evs.length - 1, 20_000)
    const perSec = (evs.length / (performance.now() - t0)) * 1000
    expect(perSec).toBeGreaterThan(10_000)
    store.close()
  })

  it('applied events keep completeness exact even when applied across many slices', async () => {
    const evs = bigStream(20_000)
    const store = new ScanStore({ fetcher: async () => new Response(sseBody(evs, { seed: 5 })), yieldFn: (cb) => void setTimeout(cb, 0) })
    store.open('k', 'live')
    const v = await until(store, (x) => x.eventsApplied >= evs.length - 1)
    expect(v.tree!.flags[0] & F_COMPLETE).toBe(F_COMPLETE)
    store.close()
  })
})


describe('ScanStore: review regressions', () => {
  it('recovers when the reducer chokes on an event: replays over a new connection instead of freezing', async () => {
    const f = byName('small')
    let attempt = 0
    const badStream = () => new Response(sseBody([['h', { version: 2, root: '/r', host: 'h', mode: 'apparent', pid: 1, started_epoch: 1, cache_file: null }], ['n', 0, -1, 'r'], ['n', 7, 0, 'skipped ids']] as any))
    const { fn } = fetcherFor(f, { live: () => (attempt++ === 0 ? badStream() : new Response(sseBody(f.events))) })
    const store = new ScanStore({ fetcher: fn })
    store.open('k', 'live')
    const v = await until(store, (x) => x.phase === 'snapshot', 10_000)
    expect(attempt).toBe(2)
    expectSameTree(v, f)
  })

  it('a closed stream reporting a finished scan (its "e" line never written) loads the snapshot instead of stalling', async () => {
    const f = byName('small')
    const noEnd = f.events.slice(0, -1)
    const { fn, calls } = fetcherFor(f, { live: () => new Response(sseBody(noEnd, { tail: 'event: closed\ndata: {"state":"done"}\n\n' })) })
    const store = new ScanStore({ fetcher: fn })
    store.open('k', 'live')
    const v = await until(store, (x) => x.phase === 'snapshot')
    expect(calls[calls.length - 1]).toContain('/api/snapshot')
    expectSameTree(v, f)
  })

  it('aborts the connection when a stream message cannot be handled, so the server stops tailing', async () => {
    const f = byName('small')
    let aborted = false
    let n = 0
    const store = new ScanStore({
      fetcher: async (path: string, init?: RequestInit) => {
        if (!path.startsWith('/api/live')) return new Response(fs.readFileSync(f.snapshotFile, 'utf8'))
        if (n++ === 0) {
          init?.signal?.addEventListener('abort', () => (aborted = true))
          return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('event: error\ndata: {"error":"boom"}\n\n')) } }))
        }
        return new Response(sseBody(f.events))
      },
    })
    store.open('k', 'live')
    await until(store, (x) => x.phase === 'snapshot', 10_000)
    expect(aborted).toBe(true)
  })
})
