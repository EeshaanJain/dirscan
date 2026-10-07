import { useEffect, useRef, useState } from 'react'

/** `value`, but updated at most once per `ms` (leading and trailing edge). */
export function useThrottled<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value)
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const since = Date.now() - last.current
    if (since >= ms) {
      last.current = Date.now()
      setOut(value)
    } else {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        last.current = Date.now()
        setOut(value)
      }, ms - since)
    }
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [value, ms])
  return out
}

/** `value` once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return out
}
