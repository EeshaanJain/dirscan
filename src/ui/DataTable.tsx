// shadcn "data table" pattern: react-table (v9) for sorting state and row models, shadcn Table
// parts for the look, @tanstack/react-virtual so only the visible rows are in the DOM.
//
// The shadcn <Table> wrapper adds its own overflow-x container, which would swallow vertical
// scrolling and break the sticky header, so the parts (TableHeader, TableRow, …) are composed
// directly inside this component's own scroll container.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  createColumnHelper, createSortedRowModel, rowSortingFeature, sortFn_basic, sortFn_text, tableFeatures, useTable,
  type ColumnDef, type Row, type RowData, type SortingState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from 'lucide-react'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

export const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { basic: sortFn_basic, text: sortFn_text },
})
export type Features = typeof features
// the value type varies per column (string, number, …), so it is left open
export type Column<T extends RowData> = ColumnDef<Features, T, any>
export const columnHelper = <T extends RowData>() => createColumnHelper<Features, T>()

export interface DataTableProps<T extends RowData> {
  data: T[]
  columns: Column<T>[]
  getRowId: (row: T) => string
  /** CSS width per column id (table-fixed layout); unlisted columns share the rest */
  widths?: Record<string, string>
  /** the table never gets narrower than this (px); the scroller scrolls sideways instead */
  minWidth?: number
  /** columns to right-align (numbers) */
  alignRight?: string[]
  initialSort?: SortingState
  rowHeight?: number
  /** row to highlight from outside (e.g. hovered treemap tile) */
  highlightId?: string | null
  onRowClick?: (row: T) => void
  /** Enter on the active row, or double click */
  onRowActivate?: (row: T) => void
  onRowHover?: (row: T | null) => void
  empty?: ReactNode
  className?: string
  'aria-label'?: string
}

export function DataTable<T extends RowData>({
  data, columns, getRowId, widths = {}, minWidth, alignRight = [], initialSort = [], rowHeight = 28, highlightId,
  onRowClick, onRowActivate, onRowHover, empty, className, ...rest
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSort)
  const table = useTable({ features, columns, data, getRowId, state: { sorting }, onSortingChange: setSorting })
  const rows: Row<Features, T>[] = table.getRowModel().rows

  const scrollRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  })
  const items = virt.getVirtualItems()
  const padTop = items.length ? items[0].start : 0
  const padBottom = items.length ? virt.getTotalSize() - items[items.length - 1].end : 0

  // keyboard cursor, tracked by id so it survives re-sorting and live updates
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeIndex = useMemo(() => (activeId === null ? -1 : rows.findIndex((r) => r.id === activeId)), [rows, activeId])

  const move = (to: number) => {
    if (!rows.length) return
    const i = Math.max(0, Math.min(rows.length - 1, to))
    setActiveId(rows[i].id)
    virt.scrollToIndex(i, { align: 'auto' })
    onRowHover?.(rows[i].original)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return
    switch (e.key) {
      case 'ArrowDown': move(activeIndex < 0 ? 0 : activeIndex + 1); break
      case 'ArrowUp': move(activeIndex < 0 ? 0 : activeIndex - 1); break
      case 'PageDown': move((activeIndex < 0 ? 0 : activeIndex) + 10); break
      case 'PageUp': move((activeIndex < 0 ? 0 : activeIndex) - 10); break
      case 'Home': move(0); break
      case 'End': move(rows.length - 1); break
      case 'Enter':
        if (activeIndex >= 0) onRowActivate?.(rows[activeIndex].original)
        else return
        break
      default: return
    }
    e.preventDefault()
  }

  // drop the cursor when its row disappears
  useEffect(() => {
    if (activeId !== null && activeIndex < 0 && rows.length) setActiveId(null)
  }, [activeId, activeIndex, rows.length])

  const right = new Set(alignRight)
  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      role="grid"
      aria-label={rest['aria-label']}
      aria-rowcount={rows.length}
      onKeyDown={onKeyDown}
      className={cn('relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring/50', className)}
    >
      <table className="w-full table-fixed caption-bottom text-xs tabular-nums" style={minWidth ? { minWidth } : undefined}>
        <colgroup>
          {table.getAllLeafColumns().map((c) => (
            <col key={c.id} style={widths[c.id] ? { width: widths[c.id] } : undefined} />
          ))}
        </colgroup>
        <TableHeader className="sticky top-0 z-10 bg-background shadow-[0_1px_0_var(--border)]">
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id} className="hover:bg-transparent">
              {hg.headers.map((h) => {
                const sorted = h.column.getIsSorted()
                const canSort = h.column.getCanSort()
                return (
                  <TableHead
                    key={h.id}
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    className={cn('h-7 px-2 text-xs', right.has(h.column.id) && 'text-right')}
                  >
                    {h.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        onClick={h.column.getToggleSortingHandler()}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-sm font-medium hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
                          right.has(h.column.id) && 'flex-row-reverse',
                          sorted ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        <table.FlexRender header={h} />
                        {sorted === 'asc' ? <ArrowUpIcon className="size-3" /> : sorted === 'desc' ? <ArrowDownIcon className="size-3" /> : <ChevronsUpDownIcon className="size-3 opacity-40" />}
                      </button>
                    ) : (
                      <table.FlexRender header={h} />
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {padTop > 0 && (
            <tr aria-hidden style={{ height: padTop }}>
              <td colSpan={columns.length} />
            </tr>
          )}
          {items.map((vi) => {
            const row = rows[vi.index]
            const selected = row.id === activeId || row.id === highlightId
            return (
              <TableRow
                key={row.id}
                aria-rowindex={vi.index + 1}
                data-state={selected ? 'selected' : undefined}
                style={{ height: rowHeight }}
                className={cn(onRowClick && 'cursor-pointer')}
                onClick={() => {
                  setActiveId(row.id)
                  onRowClick?.(row.original)
                }}
                onDoubleClick={() => onRowActivate?.(row.original)}
                onMouseEnter={() => onRowHover?.(row.original)}
                onMouseLeave={() => onRowHover?.(null)}
              >
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id} className={cn('truncate px-2 py-0', right.has(cell.column.id) && 'text-right')}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            )
          })}
          {padBottom > 0 && (
            <tr aria-hidden style={{ height: padBottom }}>
              <td colSpan={columns.length} />
            </tr>
          )}
        </TableBody>
      </table>
      {!rows.length && empty}
    </div>
  )
}
