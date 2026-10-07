import { CopyIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText } from '@/lib/clipboard'

export async function copyWithToast(text: string, what = 'Path') {
  const ok = await copyText(text)
  toast.add(ok ? { title: `${what} copied`, description: text, type: 'success' } : { title: 'Could not copy', description: 'Clipboard access was denied.', type: 'error' })
}

export function CopyButton({ text, label = 'Copy path', what }: { text: string; label?: string; what?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon-xs" aria-label={label} onClick={(e) => { e.stopPropagation(); void copyWithToast(text, what) }} />}
      >
        <CopyIcon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
