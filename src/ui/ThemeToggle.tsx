import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTheme, type Theme } from '@/ui/ThemeProvider'

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  return (
    <ToggleGroup
      variant="outline"
      size="sm"
      aria-label="Theme"
      value={[theme]}
      onValueChange={(v) => v[0] && setTheme(v[0] as Theme)}
    >
      <ToggleGroupItem value="light" aria-label="Light theme"><SunIcon /></ToggleGroupItem>
      <ToggleGroupItem value="dark" aria-label="Dark theme"><MoonIcon /></ToggleGroupItem>
      <ToggleGroupItem value="system" aria-label="System theme"><MonitorIcon /></ToggleGroupItem>
    </ToggleGroup>
  )
}
