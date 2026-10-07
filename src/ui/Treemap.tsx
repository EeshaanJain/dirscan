import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpenIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useElementSize } from '@/hooks/use-element-size'
import { useThemePalette, type Palette } from '@/hooks/use-theme-palette'
import { useThrottled } from '@/hooks/use-throttled'
import { formatCount, formatPercent, formatSize } from '@/lib/format'
import type { ColorMode, Tab } from '@/lib/route'
import { layoutTreemap, LABEL_STRIP, sizeClass, type Tile } from '@/lib/treemap'
import { pathOf, type Tree } from '@/lib/tree'
import { cn } from '@/lib/utils'

/** live updates re-layout at most this often; the tween smooths the jump */
const RELAYOUT_MS = 1000
const TWEEN_MS = 350
const CHAR_W = 6.1
const SIZE_STEPS = [18, 34, 50, 66, 82]

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Tiles eased from where they are drawn now to where the latest layout puts them. New tiles
 * grow out of their own centre. `resetKey` (the current dir, the size) snaps without easing.
 */
function useTweenedTiles(target: Tile[], resetKey: string): Tile[] {
  const [shown, setShown] = useState(target)
  const shownRef = useRef(target)
  const keyRef = useRef(resetKey)
  useEffect(() => {
    if (keyRef.current !== resetKey || reducedMotion()) {
      keyRef.current = resetKey
      shownRef.current = target
      setShown(target)
      return
    }
    const from = new Map(shownRef.current.map((t) => [t.key, t]))
    const start = performance.now()
    let raf = 0
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / TWEEN_MS)
      const e = 1 - (1 - p) ** 3
      const cur = target.map((t) => {
        const f = from.get(t.key) ?? { ...t, x: t.x + t.w / 2, y: t.y + t.h / 2, w: 0, h: 0 }
        return { ...t, x: f.x + (t.x - f.x) * e, y: f.y + (t.y - f.y) * e, w: f.w + (t.w - f.w) * e, h: f.h + (t.h - f.h) * e }
      })
      shownRef.current = cur
      setShown(cur)
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, resetKey])
  return shown
}

function fillFor(t: Tile, mode: ColorMode, dirTotal: number, pal: Palette): string {
  const { background: bg, mutedForeground: muted } = pal
  if (t.kind === 'files') return `color-mix(in oklch, ${muted} 38%, ${bg})`
  if (t.kind === 'other') return `color-mix(in oklch, ${muted} 22%, ${bg})`
  if (t.kind === 'pending') return `color-mix(in oklch, ${muted} 10%, ${bg})`
  const hue = mode === 'size' ? pal.hues[0] : pal.hues[((t.group % 5) + 5) % 5]
  // a level-1 tile that holds children is a quiet backdrop; leaves and level-2 tiles carry the colour
  const nested = t.level === 1 && t.strip
  const amount = mode === 'size' ? SIZE_STEPS[sizeClass(t.bytes, dirTotal)] : nested ? 24 : 64
  return `color-mix(in oklch, ${hue} ${amount}%, ${bg})`
}

function truncate(s: string, px: number): string {
  const max = Math.floor(px / CHAR_W)
  if (max < 2) return ''
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`
}

export interface TreemapProps {
  tree: Tree
  /** bumps when the tree changed (live) */
  version: number
  dir: number
  root: string
  live: boolean
  colorMode: ColorMode
  /** dir id highlighted from outside (table row hover) */
  hoverId: number | null
  onHover: (id: number | null) => void
  onOpen: (id: number, tab?: Tab) => void
}

export function Treemap({ tree, version, dir, root, live, colorMode, hoverId, onHover, onOpen }: TreemapProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const { width, height } = useElementSize(boxRef)
  const palette = useThemePalette()

  // while live, lay out once a second; browsing a finished scan is immediate
  const throttled = useThrottled(version, RELAYOUT_MS)
  const layoutVersion = live ? throttled : version
  const layout = useMemo(
    () => layoutTreemap(tree, dir, width, height),
    // layoutVersion stands in for the tree's mutations
    [tree, dir, width, height, layoutVersion],
  )
  const tiles = useTweenedTiles(layout.tiles, `${dir}:${width}x${height}`)

  const [hover, setHover] = useState<{ tile: Tile; x: number; y: number } | null>(null)
  const pending = useRef<{ key: string | null; x: number; y: number } | null>(null)
  const raf = useRef(0)
  const byKey = useMemo(() => new Map(layout.tiles.map((t) => [t.key, t])), [layout])

  const setPointer = (key: string | null, x: number, y: number) => {
    pending.current = { key, x, y }
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      const p = pending.current
      if (!p) return
      const tile = p.key ? byKey.get(p.key) : undefined
      setHover(tile ? { tile, x: p.x, y: p.y } : null)
      onHover(tile?.kind === 'dir' ? tile.id : null)
    })
  }
  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const rootBytes = tree.totalBytes[0]
  const total = layout.total
  const highlighted = hover?.tile.kind === 'dir' ? hover.tile.id : hoverId
  const animateStripes = live && !reducedMotion()

  const label = (t: Tile) => {
    const topStrip = t.level === 1 && t.strip
    if (t.w < 42 || t.h < 15) return null
    // while a scan runs, finished subtrees are ticked (afterwards everything would be)
    const name = live && t.kind === 'dir' && t.complete ? `✓ ${t.label}` : t.label
    const size = formatSize(t.bytes, t.lower)
    const room = t.w - 8
    return (
      <text
        x={t.x + 4}
        y={t.y + (topStrip ? LABEL_STRIP - 4 : 12)}
        className="pointer-events-none fill-foreground text-[11px]"
        style={{ fontFamily: 'var(--font-sans)' }}
      >
        {truncate(name, room)}
        {t.h >= 28 && !topStrip ? (
          <tspan x={t.x + 4} dy={12} className="fill-muted-foreground">
            {truncate(size, room)}
          </tspan>
        ) : topStrip && t.w > 120 ? (
          <tspan className="fill-muted-foreground"> {truncate(size, room - name.length * CHAR_W)}</tspan>
        ) : null}
      </text>
    )
  }

  const clickable = (t: Tile) => t.kind === 'dir' || t.kind === 'files'

  return (
    <div ref={boxRef} className="relative size-full min-h-40 overflow-hidden rounded-lg border bg-card">
      {tiles.length === 0 && width > 0 ? (
        <Empty className="size-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpenIcon />
            </EmptyMedia>
            <EmptyTitle>{live && !tree.isVisited(dir) ? 'Not scanned yet' : 'Nothing to show'}</EmptyTitle>
            <EmptyDescription>
              {live && !tree.isVisited(dir)
                ? 'This directory has not been reached by the scanner yet.'
                : 'This directory has no files with a size. The Files here tab lists it straight from disk.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Treemap of ${pathOf(tree, root, dir)}: ${tiles.length} tiles`}
          className="block select-none"
          onPointerMove={(e) => setPointer((e.target as SVGElement).dataset.key ?? null, e.clientX, e.clientY)}
          onPointerLeave={() => setPointer(null, 0, 0)}
        >
          <defs>
            {(['stripe-live', 'stripe-still'] as const).map((id) => (
              <pattern key={id} id={`tm-${id}`} width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="4" height="9" className="fill-foreground" opacity="0.13" />
                {id === 'stripe-live' && animateStripes && (
                  <animateTransform attributeName="patternTransform" type="translate" from="0 0" to="9 0" dur="0.9s" repeatCount="indefinite" additive="sum" />
                )}
              </pattern>
            ))}
          </defs>
          {tiles.map((t) => {
            const unfinished = !t.complete && t.kind !== 'files'
            const active = t.kind === 'dir' && t.id === highlighted
            const w = Math.max(0, t.w - 1)
            const h = Math.max(0, t.h - 1)
            return (
              <g key={t.key}>
                <rect
                  data-key={t.key}
                  x={t.x + 0.5}
                  y={t.y + 0.5}
                  width={w}
                  height={h}
                  rx={t.level === 1 ? 3 : 2}
                  style={{ fill: fillFor(t, colorMode, total, palette), cursor: clickable(t) ? 'pointer' : 'default' }}
                  className={cn('stroke-background', active && 'stroke-foreground')}
                  strokeWidth={active ? 2 : 1}
                  onClick={() => {
                    if (t.kind === 'dir') onOpen(t.id)
                    else if (t.kind === 'files') onOpen(t.id, 'files')
                  }}
                />
                {unfinished && w > 2 && h > 2 && (
                  <rect
                    x={t.x + 0.5}
                    y={t.y + 0.5}
                    width={w}
                    height={h}
                    rx={t.level === 1 ? 3 : 2}
                    className="pointer-events-none"
                    fill={`url(#tm-${live ? 'stripe-live' : 'stripe-still'})`}
                  />
                )}
                {label(t)}
              </g>
            )
          })}
        </svg>
      )}

      <HoverCard open={!!hover}>
        <HoverCardTrigger
          render={<span aria-hidden className="pointer-events-none fixed size-px" style={{ left: hover?.x ?? 0, top: hover?.y ?? 0 }} />}
        />
        <HoverCardContent side="right" align="start" sideOffset={14} className="w-80">
          {hover && <TileDetails tile={hover.tile} tree={tree} root={root} dirTotal={total} rootBytes={rootBytes} />}
        </HoverCardContent>
      </HoverCard>
    </div>
  )
}

function TileDetails({ tile, tree, root, dirTotal, rootBytes }: { tile: Tile; tree: Tree; root: string; dirTotal: number; rootBytes: number }) {
  const dirPath = pathOf(tree, root, tile.id)
  const where =
    tile.kind === 'dir' ? dirPath
    : tile.kind === 'files' ? `${dirPath}/ (files directly in this dir)`
    : tile.kind === 'pending' ? `${dirPath}/ (${formatCount(tile.count)} dirs not scanned yet)`
    : `${dirPath}/ (${formatCount(tile.count)} smaller dirs)`
  const status = tile.kind === 'dir' ? (tile.complete ? 'done' : tree.isVisited(tile.id) ? 'scanning' : 'pending') : null
  return (
    <div className="flex flex-col gap-1.5">
      <div className="break-all font-mono text-xs">{where}</div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs tabular-nums">
        <span className="text-muted-foreground">size</span>
        <span className="font-mono">{tile.kind === 'pending' ? 'unknown' : formatSize(tile.bytes, tile.lower)}</span>
        <span className="text-muted-foreground">of this dir</span>
        <span className="font-mono">{tile.kind === 'pending' ? '–' : formatPercent(dirTotal ? tile.bytes / dirTotal : 0)}</span>
        <span className="text-muted-foreground">of root</span>
        <span className="font-mono">{tile.kind === 'pending' ? '–' : formatPercent(rootBytes ? tile.bytes / rootBytes : 0)}</span>
        <span className="text-muted-foreground">files</span>
        <span className="font-mono">{tile.kind === 'pending' ? '–' : `${tile.lower ? '≥ ' : ''}${formatCount(tile.files)}`}</span>
      </div>
      {status && (
        <div>
          <Badge variant={status === 'done' ? 'secondary' : 'outline'}>{status}</Badge>
        </div>
      )}
      {clickableHint(tile) && <div className="text-xs text-muted-foreground">{clickableHint(tile)}</div>}
    </div>
  )
}

const clickableHint = (t: Tile) => (t.kind === 'dir' ? 'Click to open' : t.kind === 'files' ? 'Click to list these files' : null)
