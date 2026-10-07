import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ScanEntry } from '@/lib/api'
import { ScanStore, type ScanView } from '@/lib/scanStore'

/**
 * Opens `file` in a ScanStore and returns its view. Which source to use is decided when the
 * scan is opened: running (or abandoned, to replay what it got through) scans are followed
 * live, finished ones load their snapshot. A scan that finishes while open is not reopened:
 * the store itself swaps from the live tree to the snapshot at the `e` event. A new scan of the
 * same key (rescan) has a new start time, which does reopen it.
 *
 * `scans` is null until the list has loaded; nothing is opened before that.
 */
export function useScanView(file: string | null, scans: ScanEntry[] | null): { view: ScanView; entry: ScanEntry | undefined } {
  const store = useMemo(() => new ScanStore(), [])
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const entry = scans?.find((s) => s.file === file)
  const loaded = scans !== null

  const modeRef = useRef<'live' | 'snapshot'>('snapshot')
  modeRef.current = entry && (entry.state === 'running' || entry.state === 'abandoned') ? 'live' : 'snapshot'
  const remote = entry?.state === 'remote'
  const openKey = file && loaded && !remote ? `${file}@${entry?.started_epoch ?? 0}` : null

  useEffect(() => {
    if (!file || !openKey) {
      store.close()
      return
    }
    store.open(file, modeRef.current)
    return () => store.close()
    // openKey carries (file, start time); the mode is read at open time on purpose
  }, [store, openKey, file])

  return { view, entry }
}
