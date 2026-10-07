import { AlertCircleIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { useScans } from '@/hooks/use-scans'
import { NewScanForm } from '@/ui/NewScanForm'
import { ScanList } from '@/ui/ScanList'

export function Dashboard({ onOpen }: { onOpen: (file: string) => void }) {
  const { scans, info, error, refresh } = useScans()
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      <NewScanForm onStarted={(file) => { void refresh(); onOpen(file) }} />
      {error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Cannot reach the server</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      {scans === null && !error ? (
        <div className="flex flex-col gap-2" aria-busy>
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
        </div>
      ) : (
        scans && <ScanList scans={scans} onOpen={onOpen} onChanged={() => void refresh()} />
      )}
      {info && (
        <p className="text-xs text-muted-foreground">
          Cache: <span className="font-mono">{info.cacheDir}</span> · this machine: <span className="font-mono">{info.host}</span>
        </p>
      )}
    </div>
  )
}
