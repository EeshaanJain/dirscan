import { useState } from 'react'
import { ArrowRightIcon, RefreshCwIcon, SquareIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toast'
import { useNow } from '@/hooks/use-now'
import { ApiError, startScan, stopScan, type ScanEntry } from '@/lib/api'
import { formatAge, formatBytes, formatCount, formatDuration } from '@/lib/format'
import { StateBadge } from '@/ui/StateBadge'
import { HardDriveIcon } from 'lucide-react'

export interface ScanListProps {
  scans: ScanEntry[]
  onOpen: (file: string) => void
  /** refresh the scan list (awaited before opening a scan that was just started) */
  onChanged: () => void | Promise<void>
}

export function ScanList({ scans, onOpen, onChanged }: ScanListProps) {
  const now = useNow()
  const [busy, setBusy] = useState<string | null>(null)

  if (!scans.length) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HardDriveIcon />
          </EmptyMedia>
          <EmptyTitle>No scans yet</EmptyTitle>
          <EmptyDescription>Scan a path above, or run <code className="font-mono">python3 dirscan.py &lt;dir&gt;</code> in a terminal and it will appear here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const run = async (file: string, what: () => Promise<void>) => {
    setBusy(file)
    try {
      await what()
    } finally {
      setBusy(null)
      onChanged()
    }
  }

  const rescan = (s: ScanEntry) =>
    run(s.file, async () => {
      try {
        const { file } = await startScan(s.root, s.mode === 'du')
        toast.add({ title: 'Scan started', description: s.root, type: 'success' })
        await onChanged()
        onOpen(file)
      } catch (e) {
        if (e instanceof ApiError && e.file) {
          await onChanged()
          onOpen(e.file)
        } else toast.add({ title: 'Could not start the scan', description: (e as Error).message, type: 'error' })
      }
    })

  const stop = (s: ScanEntry) =>
    run(s.file, async () => {
      try {
        await stopScan(s.file)
        toast.add({ title: 'Stopping scan', description: 'The scanner will write a partial snapshot.' })
      } catch (e) {
        toast.add({ title: 'Could not stop the scan', description: (e as Error).message, type: 'error' })
      }
    })

  return (
    <div className="rounded-lg border">
      <Table className="text-xs tabular-nums">
        <TableHeader>
          <TableRow>
            <TableHead>Root</TableHead>
            <TableHead>Host</TableHead>
            <TableHead>Mode</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="text-right">Size</TableHead>
            <TableHead className="text-right">Files</TableHead>
            <TableHead className="text-right">Age</TableHead>
            <TableHead className="w-48 text-right"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {scans.map((s) => {
            const running = s.state === 'running'
            const p = s.progress
            const openable = s.state !== 'remote' && !s.missing
            return (
              <TableRow key={s.file}>
                <TableCell className="max-w-0 min-w-48">
                  <div className="truncate font-mono" title={s.root}>{s.root}</div>
                  {running && (
                    <div className="mt-1 flex flex-col gap-1">
                      <Progress value={null} className="gap-0" aria-label="Scan in progress" />
                      <div className="truncate font-mono text-[11px] text-muted-foreground" title={p?.current}>
                        {p ? `${formatCount(p.files)} files · ${formatBytes(p.bytes)} · ${formatDuration(p.elapsed_s)} · ${p.current}` : 'starting…'}
                      </div>
                    </div>
                  )}
                </TableCell>
                <TableCell className="font-mono">{s.host}</TableCell>
                <TableCell>{s.mode === 'du' ? 'disk usage' : 'apparent'}</TableCell>
                <TableCell><StateBadge state={s.state} host={s.host} />{s.missing && <span className="ml-1 text-muted-foreground">(file missing)</span>}</TableCell>
                <TableCell className="text-right font-mono">{running ? (p ? formatBytes(p.bytes) : '–') : s.bytes !== undefined ? formatBytes(s.bytes) : '–'}</TableCell>
                <TableCell className="text-right font-mono">{running ? (p ? formatCount(p.files) : '–') : s.files !== undefined ? formatCount(s.files) : '–'}</TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {formatAge(s.scanned_epoch ?? s.started_epoch ?? 0, now)}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    {running && s.managed && (
                      <Button variant="destructive" size="xs" disabled={busy === s.file} onClick={() => stop(s)}>
                        {busy === s.file ? <Spinner data-icon="inline-start" /> : <SquareIcon data-icon="inline-start" />}
                        Stop
                      </Button>
                    )}
                    {!running && s.state !== 'remote' && (
                      <Button variant="outline" size="xs" disabled={busy === s.file} onClick={() => rescan(s)}>
                        {busy === s.file ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                        Rescan
                      </Button>
                    )}
                    <Button size="xs" disabled={!openable} onClick={() => onOpen(s.file)}>
                      Open
                      <ArrowRightIcon data-icon="inline-end" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
