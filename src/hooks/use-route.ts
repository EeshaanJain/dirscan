import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { buildHash, parseHash, type Route } from '@/lib/route'

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}
const getHash = () => window.location.hash

export type Navigate = (patch: Partial<Route>, opts?: { replace?: boolean }) => void

/** The view state stored in the URL hash, and a function to change it. */
export function useRoute(): [Route, Navigate] {
  const hash = useSyncExternalStore(subscribe, getHash)
  const route = useMemo(() => parseHash(hash), [hash])
  const navigate = useCallback<Navigate>((patch, opts) => {
    const next = buildHash({ ...parseHash(window.location.hash), ...patch })
    if (next === window.location.hash) return
    if (opts?.replace) {
      // replaceState does not fire hashchange
      window.history.replaceState(null, '', next)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    } else {
      window.location.hash = next
    }
  }, [])
  return [route, navigate]
}
