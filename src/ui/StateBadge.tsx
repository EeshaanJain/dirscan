import { AlertTriangleIcon, CheckIcon, CircleDashedIcon, GlobeIcon, LockIcon, PauseIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import type { ScanState } from '@/lib/api'

/** running / done / partial / abandoned / remote */
export function StateBadge({ state, host }: { state: ScanState; host?: string }) {
  switch (state) {
    case 'running':
      return (
        <Badge>
          <Spinner data-icon="inline-start" />
          running
        </Badge>
      )
    case 'done':
      return (
        <Badge variant="secondary">
          <CheckIcon data-icon="inline-start" />
          done
        </Badge>
      )
    case 'partial':
      return (
        <Badge variant="outline">
          <PauseIcon data-icon="inline-start" />
          partial
        </Badge>
      )
    case 'abandoned':
      return (
        <Badge variant="destructive">
          <AlertTriangleIcon data-icon="inline-start" />
          abandoned
        </Badge>
      )
    case 'remote':
      return (
        <Badge variant="outline">
          <GlobeIcon data-icon="inline-start" />
          {host ? `on ${host}` : 'remote'}
        </Badge>
      )
  }
}

export type DirStatus = 'done' | 'scanning' | 'pending' | 'unreadable' | 'partial'

/** Per-directory status in the Subdirs table. */
export function DirStatusBadge({ status }: { status: DirStatus }) {
  switch (status) {
    case 'done':
      return (
        <Badge variant="secondary">
          <CheckIcon data-icon="inline-start" />
          done
        </Badge>
      )
    case 'scanning':
      return (
        <Badge>
          <Spinner data-icon="inline-start" />
          scanning
        </Badge>
      )
    case 'partial':
      return (
        <Badge variant="outline">
          <PauseIcon data-icon="inline-start" />
          partial
        </Badge>
      )
    case 'pending':
      return (
        <Badge variant="outline">
          <CircleDashedIcon data-icon="inline-start" />
          pending
        </Badge>
      )
    case 'unreadable':
      return (
        <Badge variant="destructive">
          <LockIcon data-icon="inline-start" />
          unreadable
        </Badge>
      )
  }
}
