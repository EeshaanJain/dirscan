import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { CornerLeftUpIcon, GlobeIcon, SearchIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Kbd } from '@/components/ui/kbd'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useRoute } from '@/hooks/use-route'
import { useScanView } from '@/hooks/use-scan-view'
import { useScans } from '@/hooks/use-scans'
import { useThrottled } from '@/hooks/use-throttled'
import { TABS, type ColorMode, type Tab } from '@/lib/route'
import { warmSearchIndex } from '@/lib/search'
import { pathOf } from '@/lib/tree'
import { Crumbs } from '@/ui/Crumbs'
import { copyWithToast } from '@/ui/CopyButton'
import { DirTable } from '@/ui/DirTable'
import { FilesHere } from '@/ui/FilesHere'
import { LargestFiles } from '@/ui/LargestFiles'
import { ScanHeader } from '@/ui/ScanHeader'
import { SearchPalette } from '@/ui/SearchPalette'
import { Treemap } from '@/ui/Treemap'

// recharts is most of the bundle, and only this tab needs it
const ExtensionsChart = lazy(() => import('@/ui/ExtensionsChart'))

const TAB_LABELS: Record<Tab, string> = { subdirs: 'Subdirs', files: 'Files here', largest: 'Largest files', extensions: 'Extensions' }

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

export function ScanView({ file }: { file: string }) {
  const [route, navigate] = useRoute()
  const { scans, refresh } = useScans()
  const { view, entry } = useScanView(file, scans)
  const tree = view.tree
  const live = view.phase === 'live'

  // a bookmarked dir id may not exist (yet, or in this scan): fall back to the root
  const dir = tree && route.dir < tree.n ? route.dir : 0
  const [hoverId, setHoverId] = useState<number | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const narrow = useMediaQuery('(max-width: 900px)')

  // tables re-derive their rows from the tree; while live, once a second is plenty
  const slow = useThrottled(view.version, 1000)
  const tableVersion = live ? slow : view.version

  const openDir = useCallback((id: number, tab?: Tab) => navigate(tab ? { dir: id, tab } : { dir: id }), [navigate])
  const goUp = useCallback(() => {
    if (tree && dir > 0) navigate({ dir: tree.parent[dir] })
  }, [tree, dir, navigate])
  const currentPath = tree ? pathOf(tree, view.root, dir) : ''

  // a finished tree is fixed: build the search index while idle so the first search is instant
  const finished = view.phase === 'snapshot'
  useEffect(() => {
    if (!tree || !finished) return
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 200))
    const cancel = window.cancelIdleCallback ?? window.clearTimeout
    const h = idle(() => warmSearchIndex(tree))
    return () => cancel(h)
  }, [tree, finished])

  // a scan that just ended: update the sidebar and dashboard now instead of at the next poll
  useEffect(() => {
    if (view.phase === 'snapshot' || view.phase === 'stalled') void refresh()
  }, [view.phase, refresh])

  useEffect(() => {
    const base = view.root.split('/').filter(Boolean).pop()
    document.title = base ? `${base} · dirscan-view` : 'dirscan-view'
  }, [view.root])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setSearchOpen(true)
        return
      }
      if (e.key === 'ArrowLeft' && e.altKey) {
        e.preventDefault()
        goUp()
        return
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey || searchOpen) return
      // nothing focused (e.g. right after clicking a tile): arrows and Enter drive the table
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') && (e.target === document.body || (e.target as Element | null)?.closest?.('svg[role=img]'))) {
        const grid = document.querySelector<HTMLElement>('[role=grid]')
        if (grid) {
          e.preventDefault()
          grid.focus()
          grid.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, bubbles: true }))
        }
        return
      }
      if (e.key === '/') {
        e.preventDefault()
        setSearchOpen(true)
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        goUp()
      } else if (e.key === 'c' && currentPath) {
        void copyWithToast(currentPath)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goUp, currentPath, searchOpen])

  if (entry?.state === 'remote') {
    return (
      <Empty className="m-3 border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><GlobeIcon /></EmptyMedia>
          <EmptyTitle>This scan is running on {entry.host}</EmptyTitle>
          <EmptyDescription>
            Its files live on another machine, so it cannot be followed from here. Run dirscan-view on <span className="font-mono">{entry.host}</span> and tunnel in, or wait for it to finish and open the snapshot.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-4" />
        {tree ? <Crumbs tree={tree} root={view.root} dir={dir} onNavigate={(id) => openDir(id)} /> : <Skeleton className="h-4 w-64" />}
        <Button variant="ghost" size="icon-sm" aria-label="Up one level" disabled={dir === 0} onClick={goUp}>
          <CornerLeftUpIcon />
        </Button>
        <ToggleGroup variant="outline" size="sm" aria-label="Colour tiles by" value={[route.color]} onValueChange={(v) => v[0] && navigate({ color: v[0] as ColorMode }, { replace: true })}>
          <ToggleGroupItem value="top">By folder</ToggleGroupItem>
          <ToggleGroupItem value="size">By size</ToggleGroupItem>
        </ToggleGroup>
        <Button variant="outline" size="sm" onClick={() => setSearchOpen(true)} disabled={!tree}>
          <SearchIcon data-icon="inline-start" />
          Search
          <Kbd>⌘K</Kbd>
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <ScanHeader view={view} entry={entry} file={file} onOpenScan={(f) => navigate({ scan: f, dir: 0 })} />

        {tree ? (
          <ResizablePanelGroup orientation={narrow ? 'vertical' : 'horizontal'} className="min-h-0 flex-1">
            <ResizablePanel defaultSize="52%" minSize="25%">
              <Treemap
                tree={tree}
                version={view.version}
                dir={dir}
                root={view.root}
                live={live}
                colorMode={route.color}
                hoverId={hoverId}
                onHover={setHoverId}
                onOpen={openDir}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="48%" minSize="25%">
              <Tabs value={route.tab} onValueChange={(t) => navigate({ tab: t as Tab }, { replace: true })} className="size-full min-h-0 gap-2 pl-2">
                <TabsList>
                  {TABS.map((t) => (
                    <TabsTrigger key={t} value={t}>{TAB_LABELS[t]}</TabsTrigger>
                  ))}
                </TabsList>
                <TabsContent value="subdirs" className="flex min-h-0 flex-1 flex-col">
                  <DirTable tree={tree} version={tableVersion} dir={dir} root={view.root} live={live} hoverId={hoverId} onHover={setHoverId} onOpen={openDir} />
                </TabsContent>
                <TabsContent value="files" className="flex min-h-0 flex-1 flex-col">
                  <FilesHere tree={tree} version={tableVersion} dir={dir} path={currentPath} onOpenDir={openDir} />
                </TabsContent>
                <TabsContent value="largest" className="flex min-h-0 flex-1 flex-col">
                  <LargestFiles tree={tree} largest={view.largest} dir={dir} root={view.root} scope={route.scope} onScope={(scope) => navigate({ scope }, { replace: true })} onOpenDir={openDir} />
                </TabsContent>
                <TabsContent value="extensions" className="flex min-h-0 flex-1 flex-col">
                  <Suspense fallback={<Skeleton className="h-72 w-full" />}>
                    <ExtensionsChart extensions={view.extensions} />
                  </Suspense>
                </TabsContent>
              </Tabs>
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          view.phase === 'loading' && <Skeleton className="min-h-40 flex-1" aria-busy aria-label="Loading scan" />
        )}
      </div>

      <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} tree={tree} root={view.root} onPick={(id) => openDir(id)} />
    </div>
  )
}
