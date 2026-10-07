import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircleIcon, FileIcon, FolderIcon, LinkIcon, RefreshCwIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ApiError, getLs, type LsEntry, type LsResult } from '@/lib/api'
import { formatBytes, formatClock, formatCount, formatDateTime, formatSize } from '@/lib/format'
import type { Tree } from '@/lib/tree'
import { columnHelper, DataTable, type Column } from '@/ui/DataTable'
import { CopyButton } from '@/ui/CopyButton'

interface Row extends LsEntry {
  /** dir id in the scan tree, for subdirectories the scanner knows about */
  dirId: number | null
  scannedBytes: number | null
  scannedLower: boolean
}

const h = columnHelper<Row>()

type Load =
  | { kind: 'loading' }
  | { kind: 'ok'; result: LsResult }
  | { kind: 'error'; message: string; code: string }

export interface FilesHereProps {
  tree: Tree
  version: number
  dir: number
  /** absolute path of the current dir */
  path: string
  onOpenDir: (id: number) => void
}

/** The current dir listed straight from the filesystem: every file and subdir, small ones too. */
export function FilesHere({ tree, version, dir, path, onOpenDir }: FilesHereProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const abort = useRef<AbortController | null>(null)

  const fetchListing = useCallback(() => {
    abort.current?.abort()
    const ac = new AbortController()
    abort.current = ac
    setLoad({ kind: 'loading' })
    getLs(path, ac.signal).then(
      (result) => !ac.signal.aborted && setLoad({ kind: 'ok', result }),
      (e: unknown) => {
        if (ac.signal.aborted) return
        const err = e as ApiError
        setLoad({
          kind: 'error',
          code: err.code ?? 'EIO',
          message: err.code === 'EOUTSIDE' ? 'This path is outside every scanned root, so the server will not list it.' : err.message,
        })
      },
    )
  }, [path])

  useEffect(() => {
    fetchListing()
    return () => abort.current?.abort()
  }, [fetchListing])

  const rows = useMemo<Row[]>(() => {
    if (load.kind !== 'ok') return []
    const byName = new Map<string, number>()
    for (const c of tree.children(dir)) byName.set(tree.names[c], c)
    return load.result.entries.map((e) => {
      const id = e.type === 'dir' ? (byName.get(e.name) ?? null) : null
      return {
        ...e,
        dirId: id,
        scannedBytes: id === null ? null : tree.totalBytes[id],
        scannedLower: id !== null && !tree.isComplete(id),
      }
    })
    // version: the scan may have discovered more subdirs since the listing was taken
  }, [load, tree, dir, version])

  const columns = useMemo<Column<Row>[]>(
    () => [
      h.accessor('name', {
        header: 'Name',
        sortFn: 'text',
        cell: (c) => {
          const r = c.row.original
          const Icon = r.type === 'dir' ? FolderIcon : r.type === 'symlink' ? LinkIcon : FileIcon
          return (
            <span className="flex items-center gap-1.5 font-mono" title={r.name}>
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              {r.dirId !== null ? (
                <button type="button" className="truncate text-left underline-offset-2 hover:underline" onClick={() => onOpenDir(r.dirId!)}>
                  {r.name}
                </button>
              ) : (
                <span className="truncate">{r.name}</span>
              )}
              {r.target !== undefined && <span className="truncate text-muted-foreground">→ {r.target}</span>}
            </span>
          )
        },
      }),
      h.accessor('type', { header: 'Type', sortFn: 'text' }),
      h.accessor('size', { header: 'Size', sortFn: 'basic', cell: (c) => <span className="font-mono">{formatBytes(c.getValue())}</span> }),
      h.accessor((r) => r.blocks * 512, {
        id: 'disk',
        header: 'On disk',
        sortFn: 'basic',
        cell: (c) => <span className="font-mono">{formatBytes(c.getValue())}</span>,
      }),
      h.accessor((r) => r.scannedBytes ?? -1, {
        id: 'scanned',
        header: 'Scanned',
        sortFn: 'basic',
        cell: (c) => {
          const r = c.row.original
          return r.scannedBytes === null ? <span className="text-muted-foreground">–</span> : <span className="font-mono">{formatSize(r.scannedBytes, r.scannedLower)}</span>
        },
      }),
      h.accessor('mtime', { header: 'Modified', sortFn: 'basic', cell: (c) => <span className="font-mono">{formatDateTime(c.getValue())}</span> }),
      h.accessor('uid', { header: 'Uid', sortFn: 'basic' }),
      h.display({
        id: 'copy',
        header: () => <span className="sr-only">Copy</span>,
        enableSorting: false,
        cell: (c) => <CopyButton text={`${path === '/' ? '' : path}/${c.row.original.name}`} />,
      }),
    ],
    [path, onOpenDir],
  )

  const result = load.kind === 'ok' ? load.result : null
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline">live from disk</Badge>
        <span className="text-muted-foreground">
          {result ? `listed at ${formatClock(result.listedAt)}` : load.kind === 'loading' ? 'listing…' : 'not listed'}
        </span>
        {result && (
          <span className="text-muted-foreground tabular-nums">
            {result.truncated ? `showing ${formatCount(result.entries.length)} of ${formatCount(result.total)} entries, largest first` : `${formatCount(result.total)} entries`}
          </span>
        )}
        <Button variant="outline" size="xs" className="ml-auto" onClick={fetchListing} disabled={load.kind === 'loading'}>
          {load.kind === 'loading' ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
          Refresh
        </Button>
      </div>

      {load.kind === 'error' && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Cannot list this directory ({load.code})</AlertTitle>
          <AlertDescription>{load.message}</AlertDescription>
        </Alert>
      )}
      {load.kind === 'loading' && (
        <div className="flex flex-col gap-1.5" aria-busy>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      )}
      {result && (
        <DataTable
          aria-label={`Entries in ${path}`}
          data={rows}
          columns={columns}
          getRowId={(r) => r.name}
          widths={{ type: '64px', size: '80px', disk: '80px', scanned: '88px', mtime: '130px', uid: '56px', copy: '32px' }}
          minWidth={720}
          alignRight={['size', 'disk', 'scanned', 'uid']}
          initialSort={[{ id: 'size', desc: true }]}
          onRowActivate={(r) => r.dirId !== null && onOpenDir(r.dirId)}
          empty={
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderIcon />
                </EmptyMedia>
                <EmptyTitle>Empty directory</EmptyTitle>
                <EmptyDescription>Nothing is in {path} right now.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          }
        />
      )}
    </div>
  )
}
