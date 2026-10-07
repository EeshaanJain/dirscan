import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Theme = 'light' | 'dark' | 'system'
const KEY = 'dirscan-view-theme'

interface ThemeValue {
  theme: Theme
  /** what is actually showing */
  resolved: 'light' | 'dark'
  setTheme: (t: Theme) => void
}

const ThemeContext = createContext<ThemeValue | null>(null)

function readStored(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
  } catch {
    return 'system'
  }
}

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

function apply(resolved: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.style.colorScheme = resolved
}

/** Call before the first render so there is no flash of the wrong theme. */
export function applyStoredTheme() {
  const t = readStored()
  apply(t === 'system' ? (systemDark() ? 'dark' : 'light') : t)
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored)
  const [sysDark, setSysDark] = useState(systemDark)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => {
      // switch the class first: components that read CSS variables (the treemap) re-render next
      if (readStored() === 'system') apply(mq.matches ? 'dark' : 'light')
      setSysDark(mq.matches)
    }
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const resolved = theme === 'system' ? (sysDark ? 'dark' : 'light') : theme
  useEffect(() => apply(resolved), [resolved])

  const setTheme = useCallback((t: Theme) => {
    apply(t === 'system' ? (systemDark() ? 'dark' : 'light') : t) // before React re-renders readers of CSS variables
    setThemeState(t)
    try {
      localStorage.setItem(KEY, t)
    } catch {
      // storage blocked: the choice lasts until reload
    }
  }, [])

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeValue {
  const v = useContext(ThemeContext)
  if (!v) throw new Error('useTheme outside ThemeProvider')
  return v
}
