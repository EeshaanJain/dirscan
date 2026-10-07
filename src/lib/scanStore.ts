// One open scan: loads a snapshot, or follows a running scan's event stream and swaps to the
// snapshot when the scanner finishes. Exposes an immutable view for useSyncExternalStore.
//
// Live ingestion never blocks the UI: SSE batches are queued and applied in slices of a few
// milliseconds, and subscribers are notified at most every NOTIFY_MS.

import { ApiError, apiFetch, ensureOk } from './api'
import {
  applyEvent, createLiveState, type LiveEvent, type LiveHeader, type LiveState, type Progress,
} from './events'
import { readSse } from './sse'
import { buildSnapshot, type Extensions, type LargestFile, type Mode, type ScanData, type Totals } from './snapshot'
import type { Tree } from './tree'

export type Phase =
  | 'loading' // fetching / parsing a snapshot, or waiting for the first events
  | 'live' // following a running scan
  | 'ended' // live stream ended with an `e` event; fetching the snapshot
  | 'snapshot' // showing a finished snapshot
  | 'stalled' // stream closed without an `e` (scanner killed, or it ran elsewhere)
  | 'error'

export interface ScanView {
  phase: Phase
  /** bumps whenever anything below changed; the tree itself is mutated in place while live */
  version: number
  tree: Tree | null
  root: string
  host: string
  mode: Mode | null
  /** snapshot says complete (or, live, the final `e` said so); null while unknown */
  complete: boolean | null
  startedEpoch: number
  scannedEpoch: number | null
  durationS: number | null
  totals: Totals | null
  largest: LargestFile[]
  extensions: Extensions
  progress: Progress | null
  /** wall-clock ms when the first live event arrived, for files/s */
  liveSince: number | null
  /** state reported by the server when it closed a stalled stream */
  closedState: string | null
  error: string | null
  /** counters for tests and the debug footer */
  eventsApplied: number
}

const EMPTY: ScanView = {
  phase: 'loading', version: 0, tree: null, root: '', host: '', mode: null, complete: null, startedEpoch: 0,
  scannedEpoch: null, durationS: null, totals: null, largest: [], extensions: {}, progress: null, liveSince: null,
  closedState: null, error: null, eventsApplied: 0,
}

export const NOTIFY_MS = 250
/** how long one ingest slice may run before yielding to the UI */
const SLICE_MS = 8

export interface ScanStoreOptions {
  /** how to fetch; tests inject a fake */
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>
  now?: () => number
  /** defer a callback to the next macrotask */
  yieldFn?: (cb: () => void) => void
}

export class ScanStore {
  private view: ScanView = EMPTY
  private listeners = new Set<() => void>()
  private live: LiveState | null = null
  private queue: LiveEvent[][] = []
  private qi = 0
  private pumping = false
  private abort: AbortController | null = null
  private notifyTimer: ReturnType<typeof setTimeout> | null = null
  private lastNotify = 0
  private dirty = false
  private file = ''
  private generation = 0
  /** the reducer failed on an event: drop the connection and replay from the start */
  private resync = false
  private fetcher: NonNullable<ScanStoreOptions['fetcher']>
  private now: () => number
  private yieldFn: (cb: () => void) => void

  constructor(opts: ScanStoreOptions = {}) {
    this.fetcher = opts.fetcher ?? apiFetch
    this.now = opts.now ?? (() => performance.now())
    this.yieldFn = opts.yieldFn ?? ((cb) => void setTimeout(cb, 0))
  }

  subscribe = (cb: () => void) => {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }
  getSnapshot = () => this.view

  /** Open `file`. `mode`: follow its event stream, or load its snapshot. */
  open(file: string, mode: 'live' | 'snapshot') {
    this.close()
    this.file = file
    const gen = ++this.generation
    this.view = { ...EMPTY, version: this.view.version + 1 }
    this.emit(true)
    if (mode === 'snapshot') void this.loadSnapshot(gen)
    else void this.follow(gen)
  }

  close() {
    this.generation++
    this.abort?.abort()
    this.abort = null
    this.queue = []
    this.qi = 0
    this.live = null
    this.pumping = false
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.notifyTimer = null
  }

  // ------------------------------------------------------------ snapshot

  private async loadSnapshot(gen: number, keepLive = false) {
    const ac = new AbortController()
    if (!keepLive) this.abort = ac
    try {
      const res = await ensureOk(await this.fetcher(`/api/snapshot?file=${encodeURIComponent(this.file)}`, { signal: ac.signal }))
      const data = buildSnapshot(JSON.parse(await res.text()))
      if (gen !== this.generation) return
      this.live = null
      this.queue = []
      this.qi = 0
      this.setSnapshot(data)
    } catch (e) {
      if (gen !== this.generation || (e as Error).name === 'AbortError') return
      // when swapping from live, keep showing the live tree and say why
      this.patch({ phase: keepLive ? 'stalled' : 'error', error: explain(e) }, true)
    }
  }

  private setSnapshot(d: ScanData) {
    this.view = {
      ...this.view,
      phase: 'snapshot',
      version: this.view.version + 1,
      tree: d.tree,
      root: d.meta.root,
      host: d.meta.host,
      mode: d.meta.mode,
      complete: d.meta.complete,
      startedEpoch: d.meta.startedEpoch,
      scannedEpoch: d.meta.scannedEpoch ?? null,
      durationS: d.meta.durationS ?? null,
      totals: d.meta.totals ?? null,
      largest: d.largest,
      extensions: d.extensions,
      progress: null,
      error: null,
    }
    this.emit(true)
  }

  // ------------------------------------------------------------ live

  private async follow(gen: number) {
    // The server replays the file from offset 0, so reconnecting simply starts over: the
    // `h` event at the top resets the reducer.
    let attempt = 0
    while (gen === this.generation) {
      const ac = new AbortController()
      this.abort = ac
      let sawEnd = false
      let closedState: string | null = null
      try {
        const res = await ensureOk(await this.fetcher(`/api/live?file=${encodeURIComponent(this.file)}`, { signal: ac.signal }))
        await readSse(res, (m) => {
          if (gen !== this.generation) return
          if (m.event === 'message') {
            attempt = 0 // connected and receiving: the next drop starts the backoff over
            const evs = JSON.parse(m.data) as LiveEvent[]
            if (evs.some((e) => e[0] === 'e')) sawEnd = true
            this.enqueue(evs)
          } else if (m.event === 'closed') {
            closedState = (JSON.parse(m.data) as { state?: string }).state ?? 'closed'
          } else if (m.event === 'error') {
            throw new Error((JSON.parse(m.data) as { error?: string }).error ?? 'stream error')
          }
        })
      } catch (e) {
        ac.abort() // a handler that threw leaves the connection open: close it so the server stops tailing
        if (gen !== this.generation) return
        if ((e as Error).name === 'AbortError' && !this.resync) return
        if (e instanceof ApiError) {
          // the server said no (unknown scan, remote scan, bad token): retrying won't help
          this.patch({ phase: 'error', error: e.message }, true)
          return
        }
        // network blip, bad message, or a resync after the reducer choked: retry below
      }
      if (gen !== this.generation) return
      await this.drain()
      if (gen !== this.generation) return

      if (sawEnd) {
        this.resync = false
        this.patch({ phase: 'ended' }, true)
        await this.loadSnapshot(gen, true)
        return
      }
      if (closedState) {
        this.resync = false
        if (closedState === 'done' || closedState === 'partial') {
          // the scan finished but its `e` line never arrived (killed between writing the snapshot and the event)
          this.patch({ phase: 'ended' }, true)
          await this.loadSnapshot(gen, true)
        } else {
          this.patch({ phase: 'stalled', closedState }, true)
        }
        return
      }
      const wasResync = this.resync
      this.resync = false
      await new Promise((r) => setTimeout(r, wasResync ? 50 : Math.min(5000, 500 * 2 ** Math.min(attempt++, 4))))
    }
  }

  private enqueue(evs: LiveEvent[]) {
    this.queue.push(evs)
    if (!this.pumping) {
      this.pumping = true
      const gen = this.generation
      this.yieldFn(() => this.pump(gen))
    }
  }

  /** Apply queued events for at most SLICE_MS, then let the browser paint. */
  private pump(gen: number) {
    if (gen !== this.generation) return // the scan was closed or replaced while this was queued
    const t0 = this.now()
    let applied = 0
    const live = (this.live ??= createLiveState())
    try {
      while (this.qi < this.queue.length) {
        const batch = this.queue[this.qi]
        let i = 0
        // events within a batch are applied in order; check the clock every 256 events
        for (; i < batch.length; i++) {
          applyEvent(live, batch[i])
          applied++
          if ((i & 255) === 255 && this.now() - t0 > SLICE_MS) {
            i++
            break
          }
        }
        if (i < batch.length) this.queue[this.qi] = batch.slice(i)
        else this.qi++
        if (this.now() - t0 > SLICE_MS) break
      }
    } catch {
      // An event the reducer cannot apply (out-of-order id after a dropped line, say). Left
      // alone this would strand `pumping` and freeze the view for good, so: discard what is
      // queued and replay the stream from the start over a fresh connection.
      this.queue = []
      this.qi = 0
      this.live = null
      this.pumping = false
      this.resync = true
      this.abort?.abort()
      return
    }
    if (this.qi >= this.queue.length) {
      this.queue = []
      this.qi = 0
    }
    if (applied) this.syncFromLive(applied)
    if (this.qi < this.queue.length) this.yieldFn(() => this.pump(gen))
    else this.pumping = false
  }

  /** Resolves once everything received so far has been applied. */
  private async drain() {
    while (this.pumping || this.qi < this.queue.length) await new Promise((r) => setTimeout(r, 5))
  }

  private syncFromLive(applied: number) {
    const l = this.live
    if (!l) return
    const v = this.view
    const h: LiveHeader | null = l.header
    const firstData = v.phase === 'loading'
    this.view = {
      ...v,
      phase: firstData ? 'live' : v.phase,
      version: v.version + 1,
      tree: l.tree,
      root: h?.root ?? v.root,
      host: h?.host ?? v.host,
      mode: h?.mode ?? v.mode,
      startedEpoch: h?.started_epoch ?? v.startedEpoch,
      largest: l.largest,
      extensions: l.extensions,
      progress: l.progress,
      complete: l.end ? l.end.complete : null,
      totals: l.end ? l.end.totals : null,
      durationS: l.end ? l.end.durationS : null,
      liveSince: v.liveSince ?? this.now(),
      eventsApplied: v.eventsApplied + applied,
    }
    this.emit(firstData) // leaving "loading" is shown at once; the rest is throttled
  }

  // ------------------------------------------------------------ notification

  private patch(p: Partial<ScanView>, immediate: boolean) {
    this.view = { ...this.view, ...p, version: this.view.version + 1 }
    this.emit(immediate)
  }

  /** Tell subscribers, at most once per NOTIFY_MS unless `immediate`. */
  private emit(immediate: boolean) {
    const t = this.now()
    if (immediate || t - this.lastNotify >= NOTIFY_MS) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer)
      this.notifyTimer = null
      this.dirty = false
      this.lastNotify = t
      for (const l of [...this.listeners]) l()
    } else if (!this.notifyTimer) {
      this.dirty = true
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = null
        if (this.dirty) this.emit(true)
      }, NOTIFY_MS - (t - this.lastNotify))
    }
  }
}

function explain(e: unknown): string {
  if (e instanceof ApiError) return e.status === 404 ? 'No snapshot file for this scan yet.' : e.message
  return e instanceof Error ? e.message : String(e)
}
