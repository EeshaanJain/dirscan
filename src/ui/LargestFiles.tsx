import { useMemo } from 'react'
import { FileIcon, FolderOpenIcon, MoreHorizontalIcon, CopyIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatBytes, formatDateTime } from '@/lib/format'
import type { Scope } from '@/lib/route'
import type { LargestFile } from '@/lib/snapshot'
import { makeSubtreeTester, pathOf, type Tree } from '@/lib/tree'
import { copyWithToast, CopyButton } from '@/ui/CopyButton'
import { columnHelper, DataTable, type Column } from '@/ui/DataTable'

interface Row {
  key: string
  name: string
  dir: number
  /** folder shown relative to the scan root */
  folder: string
  bytes: number
  mtime: number
  path: string
}

const h = columnHelper<Row>()

export interface LargestFilesProps {
  tree: Tree
  largest: LargestFile[]
  dir: number
  root: string
  scope: Scope
  onScope: (s: Scope) => void
  onOpenDir: (id: number) => void
}

export function LargestFiles({ tree, largest, dir, root, scope, onScope, onOpenDir }: LargestFilesProps) {
  const rows = useMemo<Row[]>(() => {
    // membership is by walking parents, memoized per dir id
    const inside = makeSubtreeTester(tree, dir)
    const out: Row[] = []
    largest.forEach(([d, name, bytes, mtime], i) => {
      if (d >= tree.n || (scope === 'subtree' && !inside(d))) return
      const folder = pathOf(tree, root, d)
      out.push({
        key: `${i}:${d}:${name}`,
        name,
        dir: d,
        folder: folder.slice(root.length).replace(/^\//, '') || '.',
        bytes,
        mtime,
        path: `${folder === '/' ? '' : folder}/${name}`,
      })
    })
    return out
  }, [tree, largest, dir, root, scope])

  const columns = useMemo<Column<Row>[]>(
    () => [
      h.accessor('name', {
        header: 'File',
        sortFn: 'text',
        cell: (c) => (
          <span className="flex items-center gap-1.5 font-mono" title={c.row.original.path}>
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{c.getValue()}</span>
          </span>
        ),
      }),
      h.accessor('folder', {
        header: 'Folder',
        sortFn: 'text',
        cell: (c) => (
          <button type="button" className="block max-w-full truncate text-left font-mono text-muted-foreground underline-offset-2 hover:underline" title={c.getValue()} onClick={() => onOpenDir(c.row.original.dir)}>
            {c.getValue()}
          </button>
        ),
      }),
      h.accessor('bytes', { header: 'Size', sortFn: 'basic', cell: (c) => <span className="font-mono">{formatBytes(c.getValue())}</span> }),
      h.accessor('mtime', { header: 'Modified', sortFn: 'basic', cell: (c) => <span className="font-mono">{formatDateTime(c.getValue())}</span> }),
      h.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: (c) => (
          <span className="flex items-center justify-end">
            <CopyButton text={c.row.original.path} />
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`More actions for ${c.row.original.name}`} />}>
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => onOpenDir(c.row.original.dir)}>
                    <FolderOpenIcon />
                    Open folder in tree
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void copyWithToast(c.row.original.path)}>
                    <CopyIcon />
                    Copy path
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        ),
      }),
    ],
    [onOpenDir],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <ToggleGroup variant="outline" size="sm" aria-label="Scope" value={[scope]} onValueChange={(v) => v[0] && onScope(v[0] as Scope)}>
          <ToggleGroupItem value="subtree">This subtree</ToggleGroupItem>
          <ToggleGroupItem value="global">Global</ToggleGroupItem>
        </ToggleGroup>
        <span className="text-muted-foreground tabular-nums">
          {rows.length.toLocaleString('en-US')} of {largest.length.toLocaleString('en-US')} recorded
        </span>
      </div>
      <DataTable
        aria-label="Largest files"
        data={rows}
        columns={columns}
        getRowId={(r) => r.key}
        widths={{ folder: '170px', bytes: '80px', mtime: '130px', actions: '64px' }}
        minWidth={600}
        alignRight={['bytes']}
        initialSort={[{ id: 'bytes', desc: true }]}
        onRowActivate={(r) => onOpenDir(r.dir)}
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileIcon />
              </EmptyMedia>
              <EmptyTitle>No large files here</EmptyTitle>
              <EmptyDescription>
                {scope === 'subtree' ? 'None of the largest files recorded by the scan are in this subtree. Try Global.' : 'The scan has not reported its largest files yet.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />
    </div>
  )
}
