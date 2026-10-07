import { useEffect, useState } from 'react'

/** Current time in ms, refreshed every `everyMs`, for "5m ago" labels that should keep ticking. */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}
