import { useEffect, useMemo, useState } from 'react'
import { FolderIcon } from 'lucide-react'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { useDebounced } from '@/hooks/use-throttled'
import { formatSize } from '@/lib/format'
import { searchDirs } from '@/lib/search'
import { pathOf, type Tree } from '@/lib/tree'

const MAX_RESULTS = 200

export interface SearchPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tree: Tree | null
  root: string
  onPick: (id: number) => void
}

/**
 * Jump-to-directory palette. cmdk's own filter is turned off: it scores every item and would
 * not cope with a million dirs, so the query goes through searchDirs() (debounced) instead.
 * It searches whatever the tree holds right now, so it also works during a live scan.
 */
export function SearchPalette({ open, onOpenChange, tree, root, onPick }: SearchPaletteProps) {
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query, 120)

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const results = useMemo(() => {
    if (!open || !tree || !debounced.trim()) return []
    return searchDirs(tree, debounced, MAX_RESULTS).map((h) => ({
      id: h.id,
      name: tree.names[h.id],
      path: pathOf(tree, root, h.id).slice(root.length).replace(/^\//, '') || '(root)',
      bytes: tree.totalBytes[h.id],
      lower: !tree.isComplete(h.id),
    }))
  }, [open, tree, root, debounced])

  const empty = query.trim() === '' ? 'Type a directory name or part of its path.' : debounced !== query ? 'Searching…' : 'No matching directories.'

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search directories" description="Jump to a directory by name or path" className="sm:max-w-2xl">
      <Command shouldFilter={false}>
        <CommandInput placeholder="Search directories…" value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty>{empty}</CommandEmpty>
          {results.length > 0 && (
            <CommandGroup heading={`${results.length}${results.length === MAX_RESULTS ? '+' : ''} directories`}>
              {results.map((r) => (
                <CommandItem
                  key={r.id}
                  value={`d${r.id}`}
                  onSelect={() => {
                    onPick(r.id)
                    onOpenChange(false)
                  }}
                >
                  <FolderIcon />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-xs">{r.name}</span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">{r.path}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{formatSize(r.bytes, r.lower)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
        <div className="flex items-center gap-3 border-t px-2 py-1.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
          <span className="flex items-center gap-1"><Kbd>esc</Kbd> close</span>
        </div>
      </Command>
    </CommandDialog>
  )
}
