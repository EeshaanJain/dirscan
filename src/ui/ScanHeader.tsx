import { useState } from 'react'
import { AlertCircleIcon, AlertTriangleIcon, RefreshCwIcon, SquareIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/components/ui/toast'
import { useNow } from '@/hooks/use-now'
import { useScans } from '@/hooks/use-scans'
import { ApiError, startScan, stopScan, type ScanEntry, type ScanState } from '@/lib/api'
import { formatAge, formatBytes, formatCount, formatDuration } from '@/lib/format'
import type { ScanView } from '@/lib/scanStore'
import { CopyButton } from '@/ui/CopyButton'
import { StateBadge } from '@/ui/StateBadge'

function Stat({ label, value, mono = true, className }: { label: string; value: React.ReactNode; mono?: boolean; className?: string }) {
  return (
    <Card size="sm" className={className}>
      <CardHeader>
        <CardDescription className="text-xs">{label}</CardDescription>
        <CardTitle className={mono ? 'truncate font-mono text-sm tabular-nums' : 'text-sm'}>{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}

export interface ScanHeaderProps {
  view: ScanView
  entry?: ScanEntry
  /** file key of this scan */
  file: string
  /** open another scan key (after a rescan) */
  onOpenScan: (file: string) => void
}

export function ScanHeader({ view, entry, file, onOpenScan }: ScanHeaderProps) {
  const now = useNow()
  const { refresh } = useScans()
  const [busy, setBusy] = useState(false)
  const live = view.phase === 'live'
  const p = view.progress
  const tree = view.tree

  const bytes = live ? (p?.bytes ?? tree?.totalBytes[0] ?? 0) : (view.totals?.bytes ?? tree?.totalBytes[0] ?? 0)
  const files = live ? (p?.files ?? 0) : (view.totals?.files ?? tree?.totalFiles[0] ?? 0)
  const dirs = live ? (tree?.n ?? 0) : (view.totals?.dirs ?? tree?.n ?? 0)
  const scannedDirs = live ? (p?.dirsScanned ?? 0) : dirs
  const errors = live ? (p?.errors ?? 0) : (view.totals?.errors ?? 0)
  const elapsed = live ? (p?.elapsedS ?? 0) : (view.durationS ?? 0)
  const rate = live && elapsed > 0 ? (p?.files ?? 0) / elapsed : null

  // what the scan is, as far as the server can tell
  // A loaded snapshot is the authority; the scan list may still be a poll behind.
  const state: ScanState | null =
    view.phase === 'snapshot'
      ? view.complete ? 'done' : 'partial'
      : entry?.state ?? (live ? 'running' : null)
  const partial = view.phase !== 'live' && view.complete === false
  const stalled = view.phase === 'stalled'

  const stop = async () => {
    setBusy(true)
    try {
      await stopScan(file)
      toast.add({ title: 'Stopping scan', description: 'The scanner will write a partial snapshot.' })
      void refresh()
    } catch (e) {
      toast.add({ title: 'Could not stop the scan', description: (e as Error).message, type: 'error' })
    } finally {
      setBusy(false)
    }
  }
  const rescan = async () => {
    if (!view.mode) return
    setBusy(true)
    try {
      const { file: key } = await startScan(view.root, view.mode === 'du')
      toast.add({ title: 'Scan started', description: view.root, type: 'success' })
      await refresh() // the new run has the same key: the list must show it before the view can follow it
      onOpenScan(key)
    } catch (e) {
      if (e instanceof ApiError && e.file) {
        await refresh()
        onOpenScan(e.file)
      }
      else toast.add({ title: 'Could not start the scan', description: (e as Error).message, type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        <Card size="sm" className="col-span-2">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5 text-xs">
              Root
              {view.mode && <Badge variant="outline">{view.mode === 'du' ? 'disk usage' : 'apparent size'}</Badge>}
              {view.host && <span className="truncate font-mono">@ {view.host}</span>}
            </CardDescription>
            <CardTitle className="flex items-center gap-1 text-sm">
              <span className="truncate font-mono" title={view.root}>{view.root || '…'}</span>
              {view.root && <CopyButton text={view.root} label="Copy root path" />}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription className="flex items-center text-xs">
              {live ? 'Running for' : view.scannedEpoch ? 'Scanned' : 'State'}
              {!live && view.mode && state !== 'running' && state !== 'remote' && (
                <Button variant="ghost" size="xs" className="ml-auto -my-1" onClick={rescan} disabled={busy}>
                  {busy ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                  Rescan
                </Button>
              )}
            </CardDescription>
            <CardTitle className="flex items-center gap-1.5 text-sm">
              {state && <StateBadge state={state} host={entry?.host} />}
              <span className="font-mono text-xs font-normal tabular-nums text-muted-foreground">
                {live ? formatDuration(elapsed) : view.scannedEpoch ? formatAge(view.scannedEpoch, now) : ''}
              </span>
            </CardTitle>
          </CardHeader>
        </Card>
        <Stat label={live ? 'Bytes so far' : 'Size'} value={formatBytes(bytes)} />
        <Stat label="Files" value={formatCount(files)} />
        <Stat label={live ? 'Dirs scanned' : 'Dirs'} value={live ? `${formatCount(scannedDirs)} of ${formatCount(dirs)}` : formatCount(dirs)} />
        {live ? (
          <Stat label="Files / s" value={rate === null ? '–' : formatCount(rate)} />
        ) : (
          <Stat label="Duration" value={view.durationS ? formatDuration(view.durationS) : '–'} />
        )}
        <Stat label="Errors" value={formatCount(errors)} />
      </div>
      {live && (
        <Card size="sm">
          <CardHeader>
            <CardDescription className="flex items-center gap-2 text-xs">
              Scanning
              {entry?.managed && (
                <Button variant="destructive" size="xs" className="ml-auto -my-1" onClick={stop} disabled={busy}>
                  {busy ? <Spinner data-icon="inline-start" /> : <SquareIcon data-icon="inline-start" />}
                  Stop
                </Button>
              )}
            </CardDescription>
            <CardTitle className="truncate font-mono text-xs font-normal" title={p?.currentPath}>
              {p?.currentPath ?? 'waiting for the scanner…'}
            </CardTitle>
          </CardHeader>
          <Progress value={null} className="px-(--card-spacing)" aria-label="Scan in progress" />
        </Card>
      )}

      {(view.phase === 'ended') && (
        <Alert>
          <Spinner />
          <AlertTitle>Scan finished</AlertTitle>
          <AlertDescription>Loading the final snapshot…</AlertDescription>
        </Alert>
      )}
      {stalled && (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>{view.closedState === 'abandoned' ? 'Scan abandoned' : 'Live stream ended early'}</AlertTitle>
          <AlertDescription>
            {view.closedState === 'abandoned'
              ? 'The scanner process is gone (it was probably killed) and never wrote a snapshot. This is everything it reported before it stopped; sizes of unfinished directories are lower bounds (≥).'
              : (view.error ?? 'The event stream closed before the scan reported it was finished.')}
          </AlertDescription>
        </Alert>
      )}
      {partial && !stalled && (
        <Alert>
          <AlertTriangleIcon />
          <AlertTitle>Partial scan</AlertTitle>
          <AlertDescription>
            This scan was interrupted before it finished. Directories it did not complete show lower bounds (≥) and striped tiles.
          </AlertDescription>
        </Alert>
      )}
      {view.phase === 'error' && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Could not load this scan</AlertTitle>
          <AlertDescription>{view.error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
