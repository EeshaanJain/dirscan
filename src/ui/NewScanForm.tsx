import { useState, type FormEvent } from 'react'
import { PlayIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { toast } from '@/components/ui/toast'
import { ApiError, startScan } from '@/lib/api'

export function NewScanForm({ onStarted }: { onStarted: (file: string) => void }) {
  const [path, setPath] = useState('')
  const [mode, setMode] = useState<'apparent' | 'du'>('apparent')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const root = path.trim()
    if (!root) return
    setBusy(true)
    try {
      const { file } = await startScan(root, mode === 'du')
      toast.add({ title: 'Scan started', description: root, type: 'success' })
      setPath('')
      onStarted(file)
    } catch (err) {
      if (err instanceof ApiError && err.file) {
        toast.add({ title: 'Already scanning', description: 'Following the running scan.' })
        onStarted(err.file)
      } else {
        toast.add({ title: 'Could not start the scan', description: (err as Error).message, type: 'error' })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup className="flex-row items-end gap-2">
        <Field className="min-w-0 flex-1">
          <FieldLabel htmlFor="scan-path">Scan a path…</FieldLabel>
          <Input
            id="scan-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/absolute/path/on/this/machine"
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field className="w-fit">
          <FieldLabel>Size</FieldLabel>
          <ToggleGroup variant="outline" aria-label="Size mode" value={[mode]} onValueChange={(v) => v[0] && setMode(v[0] as 'apparent' | 'du')}>
            <ToggleGroupItem value="apparent">apparent</ToggleGroupItem>
            <ToggleGroupItem value="du">du</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Button type="submit" disabled={busy || !path.trim()}>
          {busy ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
          Scan
        </Button>
      </FieldGroup>
    </form>
  )
}
