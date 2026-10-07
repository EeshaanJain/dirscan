import { HardDriveIcon, LayoutDashboardIcon } from 'lucide-react'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu,
  SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton,
} from '@/components/ui/sidebar'
import { useScans } from '@/hooks/use-scans'
import type { ScanEntry } from '@/lib/api'
import { StateBadge } from '@/ui/StateBadge'
import { ThemeToggle } from '@/ui/ThemeToggle'

const label = (s: ScanEntry) => {
  const parts = s.root.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? '/'
}

export function AppSidebar({ current, onOpen, onDashboard }: { current: string | null; onOpen: (file: string) => void; onDashboard: () => void }) {
  const { scans, info } = useScans()
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1">
          <HardDriveIcon className="size-4" />
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="text-sm font-medium">dirscan-view</span>
            {info && <span className="truncate font-mono text-[11px] text-muted-foreground">{info.host}</span>}
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={current === null} onClick={onDashboard}>
                  <LayoutDashboardIcon />
                  <span>Dashboard</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Scans</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {scans === null
                ? [0, 1, 2].map((i) => <SidebarMenuItem key={i}><SidebarMenuSkeleton /></SidebarMenuItem>)
                : scans.map((s) => (
                    <SidebarMenuItem key={s.file}>
                      <SidebarMenuButton
                        isActive={current === s.file}
                        disabled={s.state === 'remote'}
                        tooltip={`${s.root} (${s.mode})`}
                        onClick={() => onOpen(s.file)}
                        className="h-auto items-start py-1.5 pr-20"
                      >
                        <span className="flex min-w-0 flex-col leading-tight">
                          <span className="truncate font-mono text-xs">{label(s)}</span>
                          <span className="truncate font-mono text-[11px] text-muted-foreground">{s.mode === 'du' ? 'du' : 'apparent'} · {s.host}</span>
                        </span>
                      </SidebarMenuButton>
                      <SidebarMenuBadge className="right-1 h-auto"><StateBadge state={s.state} host={s.host} /></SidebarMenuBadge>
                    </SidebarMenuItem>
                  ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center justify-between px-2">
          <span className="text-[11px] text-muted-foreground">Theme</span>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
