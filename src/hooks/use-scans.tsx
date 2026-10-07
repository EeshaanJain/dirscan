import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, getInfo, getScans, type Info, type ScanEntry } from '@/lib/api'

interface ScansValue {
  /** null until the first response */
  scans: ScanEntry[] | null
  info: Info | null
  error: ApiError | Error | null
  refresh: () => Promise<void>
}

const ScansContext = createContext<ScansValue | null>(null)

/** Polls /api/scans: quickly while something is running, slowly otherwise, never while hidden. */
export function ScansProvider({ children }: { children: ReactNode }) {
  const [scans, setScans] = useState<ScanEntry[] | null>(null)
  const [info, setInfo] = useState<Info | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const anyRunning = useRef(false)
  const refreshRef = useRef<() => Promise<void>>(async () => {})

  const refresh = useCallback(() => refreshRef.current(), [])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (stopped) return
      try {
        const list = await getScans()
        if (stopped) return
        anyRunning.current = list.some((s) => s.state === 'running')
        setScans(list)
        setError(null)
      } catch (e) {
        if (!stopped) setError(e as Error)
      }
    }
    const loop = async () => {
      if (!document.hidden) await tick()
      if (!stopped) timer = setTimeout(loop, anyRunning.current ? 1500 : 5000)
    }
    refreshRef.current = async () => {
      if (timer) clearTimeout(timer)
      await tick()
      if (!stopped) timer = setTimeout(loop, anyRunning.current ? 1500 : 5000)
    }
    getInfo().then((i) => !stopped && setInfo(i), () => {})
    void loop()
    const onVisible = () => {
      if (!document.hidden) void refreshRef.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const value = useMemo(() => ({ scans, info, error, refresh }), [scans, info, error, refresh])
  return <ScansContext.Provider value={value}>{children}</ScansContext.Provider>
}

export function useScans(): ScansValue {
  const v = useContext(ScansContext)
  if (!v) throw new Error('useScans outside ScansProvider')
  return v
}
