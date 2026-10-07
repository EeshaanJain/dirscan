const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB']

/** 1024-based, like dirscan.py: "512 B", "1.5 KB", "3.2 GB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '–'
  let v = n
  let u = 0
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024
    u++
  }
  return u === 0 ? `${Math.round(v)} B` : `${v.toFixed(v >= 100 ? 0 : 1)} ${UNITS[u]}`
}

/** A size that may only be a lower bound (incomplete subtree): "≥ 1.2 GB". */
export function formatSize(n: number, lowerBound: boolean): string {
  return lowerBound ? `≥ ${formatBytes(n)}` : formatBytes(n)
}

export function formatCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–'
}

export function formatPercent(frac: number): string {
  if (!Number.isFinite(frac) || frac <= 0) return '0%'
  const p = frac * 100
  if (p < 0.1) return '<0.1%'
  if (p >= 100) return '100%'
  return `${p < 10 ? p.toFixed(1) : p.toFixed(p < 99.5 ? 0 : 1)}%`
}

/** "12s ago", "5m ago", "3h ago", "2d ago". `nowMs` is injectable for tests. */
export function formatAge(epochSeconds: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.floor(nowMs / 1000 - epochSeconds))
  if (s >= 86400) return `${Math.floor(s / 86400)}d ago`
  if (s >= 3600) return `${Math.floor(s / 3600)}h ago`
  if (s >= 60) return `${Math.floor(s / 60)}m ago`
  return `${s}s ago`
}

/** "850ms", "12.3s", "4m 05s", "2h 03m". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '–'
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local "2026-10-07 08:41" for a file mtime. */
export function formatDateTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Local "08:41:07", for "listed at". */
export function formatClock(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function formatMode(mode: number): string {
  const kind = (mode & 0o170000) === 0o040000 ? 'd' : (mode & 0o170000) === 0o120000 ? 'l' : '-'
  let out = kind
  for (let i = 8; i >= 0; i--) out += mode & (1 << i) ? 'rwx'[(8 - i) % 3] : '-'
  return out
}
