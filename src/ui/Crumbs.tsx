import { Fragment } from 'react'
import { Breadcrumb, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ancestry, type Tree } from '@/lib/tree'

const KEEP_TAIL = 3

/** '/a/b/c/d/proj' -> '…/d/proj': the full path is in the tooltip and the header card. */
const shortRoot = (root: string) => {
  const parts = root.split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : root
}

export interface CrumbsProps {
  tree: Tree
  root: string
  dir: number
  onNavigate: (id: number) => void
}

/** Every segment from the root down to the current dir is clickable; long chains collapse in the middle. */
export function Crumbs({ tree, root, dir, onNavigate }: CrumbsProps) {
  const ids = ancestry(tree, dir)
  const label = (id: number) => (id === 0 ? shortRoot(root) : tree.names[id])
  const title = (id: number) => (id === 0 ? root : tree.names[id])
  const collapse = ids.length > KEEP_TAIL + 2
  const hidden = collapse ? ids.slice(1, ids.length - KEEP_TAIL) : []
  const shown = collapse ? [ids[0], ...ids.slice(ids.length - KEEP_TAIL)] : ids
  const last = ids[ids.length - 1]

  return (
    <Breadcrumb className="min-w-0 flex-1">
      <BreadcrumbList className="flex-nowrap gap-1 text-xs sm:gap-1.5">
        {shown.map((id, i) => (
          <Fragment key={id}>
            <BreadcrumbItem className="min-w-0">
              {id === last ? (
                <BreadcrumbPage className="truncate font-mono" title={title(id)}>{label(id)}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink render={<button type="button" title={title(id)} onClick={() => onNavigate(id)} />} className="truncate font-mono">
                  {label(id)}
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {i < shown.length - 1 && <BreadcrumbSeparator />}
            {collapse && i === 0 && (
              <>
                <BreadcrumbItem>
                  <DropdownMenu>
                    <DropdownMenuTrigger aria-label="Show hidden folders" className="flex items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                      <BreadcrumbEllipsis />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuGroup>
                        {hidden.map((h) => (
                          <DropdownMenuItem key={h} className="font-mono text-xs" onClick={() => onNavigate(h)}>
                            {tree.names[h]}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </>
            )}
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
