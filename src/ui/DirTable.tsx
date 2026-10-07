import { useMemo } from 'react'
import { CopyIcon, FolderIcon, FolderOpenIcon, ListIcon, MoreHorizontalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { formatCount, formatPercent, formatSize } from '@/lib/format'
import type { Tab } from '@/lib/route'
import { pathOf, type Tree } from '@/lib/tree'
import { columnHelper, DataTable, type Column } from '@/ui/DataTable'
import { copyWithToast } from '@/ui/CopyButton'
import { DirStatusBadge, type DirStatus } from '@/ui/StateBadge'

interface Row {
  id: number
  name: string
  bytes: number
  /** share of the current dir, 0..1 */
  share: number
  files: number
  own: number
  lower: boolean
  status: DirStatus
}

const h = columnHelper<Row>()

function statusOf(tree: Tree, id: number, live: boolean): DirStatus {
  if (tree.isUnreadable(id)) return 'unreadable'
  if (tree.isComplete(id)) return 'done'
  if (!tree.isVisited(id)) return 'pending'
  return live ? 'scanning' : 'partial'
}

export interface DirTableProps {
  tree: Tree
  /** bumps when the tree changed */
  version: number
  dir: number
  root: string
  live: boolean
  hoverId: number | null
  onHover: (id: number | null) => void
  onOpen: (id: number, tab?: Tab) => void
}

export function DirTable({ tree, version, dir, root, live, hoverId, onHover, onOpen }: DirTableProps) {
  const data = useMemo<Row[]>(() => {
    const total = tree.totalBytes[dir]
    return tree.children(dir).map((id) => ({
      id,
      name: tree.names[id],
      bytes: tree.totalBytes[id],
      share: total ? tree.totalBytes[id] / total : 0,
      files: tree.totalFiles[id],
      own: tree.ownBytes[id],
      lower: !tree.isComplete(id),
      status: statusOf(tree, id, live),
    }))
    // version stands in for the tree's in-place mutations
  }, [tree, dir, live, version])

  const columns = useMemo<Column<Row>[]>(
    () => [
      h.accessor('name', {
        header: 'Name',
        sortFn: 'text',
        cell: (c) => (
          <span className="flex items-center gap-1.5 font-mono" title={c.getValue()}>
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{c.getValue()}</span>
          </span>
        ),
      }),
      h.accessor('bytes', {
        header: 'Total size',
        sortFn: 'basic',
        cell: (c) => c.row.original.status === 'pending' ? (
          <span className="pr-1 text-right text-muted-foreground" title="not scanned yet">–</span>
        ) : (
          <span className="flex items-center gap-2">
            <span className="w-[4.25rem] shrink-0 text-right font-mono">{formatSize(c.getValue(), c.row.original.lower)}</span>
            <Progress value={c.row.original.share * 100} className="min-w-0 flex-1 gap-0" aria-label={formatPercent(c.row.original.share)} />
            <span className="w-9 shrink-0 text-right text-muted-foreground">{formatPercent(c.row.original.share)}</span>
          </span>
        ),
      }),
      h.accessor('files', { header: 'Files', sortFn: 'basic', cell: (c) => <span className="font-mono">{formatCount(c.getValue())}</span> }),
      h.accessor('own', { header: 'Own', sortFn: 'basic', cell: (c) => <span className="font-mono">{formatSize(c.getValue(), false)}</span> }),
      h.accessor('status', { header: 'Status', sortFn: 'text', cell: (c) => <DirStatusBadge status={c.getValue()} /> }),
      h.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: (c) => <RowActions row={c.row.original} tree={tree} root={root} onOpen={onOpen} />,
      }),
    ],
    [tree, root, onOpen],
  )

  return (
    <DataTable
      aria-label="Subdirectories"
      data={data}
      columns={columns}
      getRowId={(r) => String(r.id)}
      widths={{ bytes: '230px', files: '68px', own: '76px', status: '100px', actions: '30px' }}
      minWidth={620}
      alignRight={['files', 'own']}
      initialSort={[{ id: 'bytes', desc: true }]}
      highlightId={hoverId === null ? null : String(hoverId)}
      onRowClick={(r) => onOpen(r.id)}
      onRowActivate={(r) => onOpen(r.id)}
      onRowHover={(r) => onHover(r ? r.id : null)}
      empty={
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpenIcon />
            </EmptyMedia>
            <EmptyTitle>No subdirectories</EmptyTitle>
            <EmptyDescription>{live ? 'None found so far.' : 'This directory only holds files.'}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      }
    />
  )
}

function RowActions({ row, tree, root, onOpen }: { row: Row; tree: Tree; root: string; onOpen: DirTableProps['onOpen'] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Actions for ${row.name}`} onClick={(e) => e.stopPropagation()} />}>
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onOpen(row.id)}>
            <FolderOpenIcon />
            Open in tree
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onOpen(row.id, 'files')}>
            <ListIcon />
            Files here (live)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copyWithToast(pathOf(tree, root, row.id))}>
            <CopyIcon />
            Copy path
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
