// Event reducer for the live stream (<snapshot>.events.ndjson, format version 2).
// Applying events in order rebuilds the same tree as the final snapshot. All upkeep is
// incremental: O(depth) per event, never a recompute.

import type { Extensions, LargestFile, Mode, Totals } from './snapshot'
import { F_COMPLETE, F_UNREADABLE, F_VISITED, Tree } from './tree'

export interface LiveHeader {
  version: number
  root: string
  host: string
  mode: Mode
  pid: number
  started_epoch: number
  cache_file: string | null
}

export interface Progress {
  files: number
  dirsScanned: number
  bytes: number
  errors: number
  elapsedS: number
  currentPath: string
}

export interface EndInfo {
  complete: boolean
  durationS: number
  cacheFile: string | null
  totals: Totals
}

export interface LiveState {
  tree: Tree
  header: LiveHeader | null
  progress: Progress | null
  largest: LargestFile[]
  extensions: Extensions
  end: EndInfo | null
  /** events applied since the last reset */
  events: number
  /** how many times an `h` event reset the state */
  resets: number
}

export function createLiveState(): LiveState {
  return {
    tree: new Tree(),
    header: null,
    progress: null,
    largest: [],
    extensions: {},
    end: null,
    events: 0,
    resets: 0,
  }
}

export function resetLiveState(st: LiveState) {
  st.tree = new Tree()
  st.header = null
  st.progress = null
  st.largest = []
  st.extensions = {}
  st.end = null
  st.events = 0
  st.resets++
}

export type LiveEvent = unknown[]

export function applyEvents(st: LiveState, evs: readonly LiveEvent[]) {
  for (const ev of evs) applyEvent(st, ev)
}

export function applyEvent(st: LiveState, ev: LiveEvent) {
  const t = st.tree
  switch (ev[0]) {
    case 'h': {
      resetLiveState(st)
      st.header = ev[1] as LiveHeader
      break
    }
    case 'n': {
      // dir discovered, not yet scanned: it (and every ancestor) has one more unvisited dir
      const id = ev[1] as number
      const parent = ev[2] as number
      t.addDir(id, parent, ev[3] as string)
      t.pending[id] = 1
      for (let a = parent; a >= 0; a = t.parent[a]) {
        t.pending[a]++
        t.flags[a] &= ~F_COMPLETE
      }
      break
    }
    case 's': {
      const id = ev[1] as number
      const ownB = ev[2] as number
      const ownF = ev[3] as number
      const first = (t.flags[id] & F_VISITED) === 0
      const dB = ownB - t.ownBytes[id]
      const dF = ownF - t.ownFiles[id]
      t.ownBytes[id] = ownB
      t.ownFiles[id] = ownF
      t.flags[id] |= F_VISITED | ((ev[4] as number) & F_UNREADABLE)
      for (let a = id; a >= 0; a = t.parent[a]) {
        t.totalBytes[a] += dB
        t.totalFiles[a] += dF
        if (first && --t.pending[a] === 0) t.flags[a] |= F_COMPLETE
      }
      break
    }
    case 'p': {
      st.progress = {
        files: ev[1] as number,
        dirsScanned: ev[2] as number,
        bytes: ev[3] as number,
        errors: ev[4] as number,
        elapsedS: ev[5] as number,
        currentPath: ev[6] as string,
      }
      break
    }
    case 'L':
      st.largest = ev[1] as LargestFile[]
      break
    case 'x':
      st.extensions = ev[1] as Extensions
      break
    case 'e': {
      const e = ev[1] as { complete: boolean; duration_s: number; cache_file: string | null; totals: Totals }
      st.end = { complete: e.complete, durationS: e.duration_s, cacheFile: e.cache_file, totals: e.totals }
      break
    }
    default:
      return // unknown event types are ignored so newer scanners don't break the viewer
  }
  t.version++
  st.events++
}
