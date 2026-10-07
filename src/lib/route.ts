// All view state lives in the URL hash so reloads and bookmarks work:
//   #/                                       dashboard
//   #/scan?file=<snapshot key>&dir=12&tab=files&color=size&scope=global

export const TABS = ['subdirs', 'files', 'largest', 'extensions'] as const
export type Tab = (typeof TABS)[number]
export type ColorMode = 'top' | 'size'
export type Scope = 'subtree' | 'global'

export interface Route {
  /** snapshot key of the open scan, or null for the dashboard */
  scan: string | null
  dir: number
  tab: Tab
  color: ColorMode
  scope: Scope
}

export const DEFAULT_ROUTE: Route = { scan: null, dir: 0, tab: 'subdirs', color: 'top', scope: 'subtree' }

export function parseHash(hash: string): Route {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  const q = h.indexOf('?')
  const path = q < 0 ? h : h.slice(0, q)
  const params = new URLSearchParams(q < 0 ? '' : h.slice(q + 1))
  const file = params.get('file')
  if (path !== '/scan' || !file) return { ...DEFAULT_ROUTE }
  const dir = Number(params.get('dir'))
  const tab = params.get('tab')
  const color = params.get('color')
  const scope = params.get('scope')
  return {
    scan: file,
    dir: Number.isInteger(dir) && dir >= 0 ? dir : 0,
    tab: (TABS as readonly string[]).includes(tab ?? '') ? (tab as Tab) : DEFAULT_ROUTE.tab,
    color: color === 'size' ? 'size' : 'top',
    scope: scope === 'global' ? 'global' : 'subtree',
  }
}

/** Defaults are left out so URLs stay short. */
export function buildHash(route: Route): string {
  if (!route.scan) return '#/'
  const p = new URLSearchParams({ file: route.scan })
  if (route.dir) p.set('dir', String(route.dir))
  if (route.tab !== DEFAULT_ROUTE.tab) p.set('tab', route.tab)
  if (route.color !== DEFAULT_ROUTE.color) p.set('color', route.color)
  if (route.scope !== DEFAULT_ROUTE.scope) p.set('scope', route.scope)
  return `#/scan?${p}`
}
