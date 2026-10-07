import { KeyRoundIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { Toaster } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ScansProvider, useScans } from '@/hooks/use-scans'
import { useRoute } from '@/hooks/use-route'
import { getToken } from '@/lib/api'
import { AppSidebar } from '@/ui/AppSidebar'
import { Dashboard } from '@/ui/Dashboard'
import { ScanView } from '@/ui/ScanView'
import { ThemeProvider } from '@/ui/ThemeProvider'

function TokenMissing() {
  return (
    <div className="mx-auto mt-16 max-w-xl p-4">
      <Alert variant="destructive">
        <KeyRoundIcon />
        <AlertTitle>This page needs the access token</AlertTitle>
        <AlertDescription>
          dirscan-view prints a URL with <span className="font-mono">?token=…</span> when it starts. Open that exact URL (through your SSH tunnel if the viewer runs on a remote machine). The token is kept for this tab only.
        </AlertDescription>
      </Alert>
    </div>
  )
}

function Shell() {
  const [route, navigate] = useRoute()
  const { error } = useScans()
  if (!getToken() || (error && 'code' in error && error.code === 'ETOKEN')) return <TokenMissing />
  const open = (file: string) => navigate({ scan: file, dir: 0, tab: 'subdirs' })
  return (
    <SidebarProvider className="h-svh">
      <AppSidebar current={route.scan} onOpen={open} onDashboard={() => navigate({ scan: null })} />
      <SidebarInset className="min-h-0 min-w-0">
        {route.scan ? (
          <ScanView key={route.scan} file={route.scan} />
        ) : (
          <>
            <header className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
              <SidebarTrigger />
              <Separator orientation="vertical" className="h-4" />
              <h1 className="text-sm font-medium">Scans</h1>
            </header>
            <Dashboard onOpen={open} />
          </>
        )}
      </SidebarInset>
    </SidebarProvider>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <ScansProvider>
          <Shell />
          <Toaster />
        </ScansProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}
