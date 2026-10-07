import { useMemo } from 'react'
import { useTheme } from '@/ui/ThemeProvider'

export interface Palette {
  /** the five chart colours, cycled for top-level ancestors */
  hues: string[]
  background: string
  foreground: string
  mutedForeground: string
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/**
 * Theme colours read from the shadcn CSS variables, so a canvas/SVG drawing follows light and
 * dark mode. ThemeProvider switches the `dark` class before re-rendering, so this sees the
 * new values.
 */
export function useThemePalette(): Palette {
  const { resolved } = useTheme()
  return useMemo(
    () => ({
      hues: [1, 2, 3, 4, 5].map((i) => css(`--chart-${i}`)),
      background: css('--background'),
      foreground: css('--foreground'),
      mutedForeground: css('--muted-foreground'),
    }),
    [resolved],
  )
}
