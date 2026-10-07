import { useMemo } from 'react'
import { Bar, BarChart, XAxis, YAxis } from 'recharts'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { formatBytes, formatCount } from '@/lib/format'
import type { Extensions } from '@/lib/snapshot'
import { columnHelper, DataTable, type Column } from '@/ui/DataTable'

interface Row {
  ext: string
  bytes: number
  files: number
}

const h = columnHelper<Row>()
const config = { bytes: { label: 'Size', color: 'var(--chart-1)' } } satisfies ChartConfig
const TOP = 20

export default function ExtensionsChart({ extensions }: { extensions: Extensions }) {
  const rows = useMemo<Row[]>(
    () => Object.entries(extensions).map(([ext, v]) => ({ ext, bytes: v.bytes, files: v.files })).sort((a, b) => b.bytes - a.bytes),
    [extensions],
  )
  const top = rows.slice(0, TOP)
  const total = useMemo(() => rows.reduce((s, r) => s + r.bytes, 0), [rows])

  const columns = useMemo<Column<Row>[]>(
    () => [
      h.accessor('ext', { header: 'Extension', sortFn: 'text', cell: (c) => <span className="font-mono">{c.getValue()}</span> }),
      h.accessor('files', { header: 'Files', sortFn: 'basic', cell: (c) => <span className="font-mono">{formatCount(c.getValue())}</span> }),
      h.accessor('bytes', { header: 'Size', sortFn: 'basic', cell: (c) => <span className="font-mono">{formatBytes(c.getValue())}</span> }),
      h.accessor((r) => (total ? r.bytes / total : 0), {
        id: 'share',
        header: '%',
        sortFn: 'basic',
        cell: (c) => <span className="font-mono">{(c.getValue() * 100).toFixed(1)}%</span>,
      }),
    ],
    [total],
  )

  if (!rows.length) {
    return <p className="p-2 text-sm text-muted-foreground">The scan has not reported extension totals yet.</p>
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-2 pr-3">
        <div className="flex items-center gap-2 text-xs">
          <Badge variant="outline">global</Badge>
          <span className="text-muted-foreground">Whole scan, not just this directory. Top {Math.min(TOP, rows.length)} by size.</span>
        </div>
        <ChartContainer config={config} className="aspect-auto h-[360px] w-full shrink-0">
          <BarChart accessibilityLayer data={top} layout="vertical" margin={{ left: 4, right: 12 }}>
            <YAxis dataKey="ext" type="category" tickLine={false} axisLine={false} width={72} interval={0} tick={{ fontSize: 11, fontFamily: 'var(--font-mono, monospace)' }} />
            <XAxis type="number" hide />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  hideLabel
                  formatter={(_value, _name, item) => {
                    const p = item.payload as Row
                    return (
                      <div className="flex flex-col gap-0.5 tabular-nums">
                        <span className="font-mono font-medium">{p.ext}</span>
                        <span>{formatBytes(p.bytes)}</span>
                        <span className="text-muted-foreground">{formatCount(p.files)} files</span>
                      </div>
                    )
                  }}
                />
              }
            />
            <Bar dataKey="bytes" fill="var(--color-bytes)" radius={3} isAnimationActive={false} />
          </BarChart>
        </ChartContainer>
        <div className="flex h-72 shrink-0 flex-col">
          <DataTable
            aria-label="Extensions"
            data={rows}
            columns={columns}
            getRowId={(r) => r.ext}
            widths={{ files: '90px', bytes: '96px', share: '70px' }}
            alignRight={['files', 'bytes', 'share']}
            initialSort={[{ id: 'bytes', desc: true }]}
          />
        </div>
      </div>
    </ScrollArea>
  )
}
