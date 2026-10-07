import fs from 'node:fs'
import path from 'node:path'
import { parseSnapshot, type ScanData } from '@/lib/snapshot'
import type { LiveEvent } from '@/lib/events'

export const CACHE_DIR = path.resolve(import.meta.dirname, '../fixtures/cache')

export interface Fixture {
  name: string
  snapshotFile: string
  eventsFile: string
  snapshot: ScanData
  /** raw bytes of the events file */
  eventBytes: Buffer
  events: LiveEvent[]
}

/** Fixture names are the scanned dir's name: small, small-du, flat, empty, unreadable, big. */
export function loadFixtures(): Fixture[] {
  const index = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'index.json'), 'utf8')) as Record<
    string,
    { mode: string; events: string }
  >
  return Object.entries(index).map(([snapPath, m]) => {
    const snapshotFile = path.join(CACHE_DIR, path.basename(snapPath))
    const eventsFile = path.join(CACHE_DIR, path.basename(m.events))
    const eventBytes = fs.readFileSync(eventsFile)
    const snapshot = parseSnapshot(fs.readFileSync(snapshotFile, 'utf8'))
    const base = path.basename(snapshot.meta.root)
    return {
      name: m.mode === 'du' ? `${base}-du` : base,
      snapshotFile,
      eventsFile,
      snapshot,
      eventBytes,
      events: eventBytes
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LiveEvent),
    }
  })
}

/** Deterministic PRNG so failing chunkings can be reproduced. */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
