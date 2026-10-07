import { useLayoutEffect, useState, type RefObject } from 'react'

/** Content-box size of an element, kept current with a ResizeObserver. */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const r = el.getBoundingClientRect()
      setSize((s) => (s.width === Math.floor(r.width) && s.height === Math.floor(r.height) ? s : { width: Math.floor(r.width), height: Math.floor(r.height) }))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}
