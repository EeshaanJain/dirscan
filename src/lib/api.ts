// Client for the dirscan-view server. Every /api call carries the per-run token in a header.

export const TOKEN_HEADER = 'x-dirscan-token'
const TOKEN_KEY = 'dirscan-view-token'

let token: string | null = null

function storage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null // blocked storage: the token then lives only for this page load
  }
}

/**
 * Take the token from `?token=` (once), keep it in sessionStorage and remove it from the
 * address bar so it doesn't end up in bookmarks, screenshots or the history.
 */
export function initToken(loc: Location = window.location, hist: History = window.history): string | null {
  const fromUrl = new URLSearchParams(loc.search).get('token')
  if (fromUrl) {
    token = fromUrl
    try {
      storage()?.setItem(TOKEN_KEY, fromUrl)
    } catch {
      // ignore
    }
    const params = new URLSearchParams(loc.search)
    params.delete('token')
    const rest = params.toString()
    hist.replaceState(null, '', loc.pathname + (rest ? `?${rest}` : '') + loc.hash)
  } else {
    try {
      token = storage()?.getItem(TOKEN_KEY) ?? null
    } catch {
      token = null
    }
  }
  return token
}

export const getToken = () => token

export class ApiError extends Error {
  status: number
  code: string
  file?: string
  constructor(status: number, code: string, message: string, file?: string) {
    super(message)
    this.status = status
    this.code = code
    this.file = file
  }
}

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (token) headers.set(TOKEN_HEADER, token)
  return fetch(path, { ...init, headers })
}

async function toError(res: Response): Promise<ApiError> {
  let body: { error?: string; code?: string; file?: string } = {}
  try {
    body = await res.json()
  } catch {
    // not JSON
  }
  return new ApiError(res.status, body.code ?? `HTTP${res.status}`, body.error ?? res.statusText, body.file)
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init)
  if (!res.ok) throw await toError(res)
  return (await res.json()) as T
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

/** Throws an ApiError for a non-2xx response (used for streaming endpoints). */
export async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) throw await toError(res)
  return res
}

// ---------------------------------------------------------------- types

export type ScanState = 'running' | 'done' | 'partial' | 'abandoned' | 'remote'

export interface ScanProgress {
  files: number
  dirs: number
  bytes: number
  errors: number
  elapsed_s: number
  current: string
}

/** An index.json entry plus what the server derives for it. */
export interface ScanEntry {
  file: string
  root: string
  host: string
  mode: 'apparent' | 'du'
  state: ScanState
  pid?: number
  started_epoch?: number
  scanned_epoch?: number
  duration_s?: number
  bytes?: number
  files?: number
  dirs?: number
  complete?: boolean
  in_progress?: boolean
  managed: boolean
  missing?: boolean
  progress?: ScanProgress | null
}

export interface LsEntry {
  name: string
  type: 'file' | 'dir' | 'symlink' | 'other'
  size: number
  blocks: number
  mtime: number
  mode: number
  uid: number
  target?: string
}

export interface LsResult {
  path: string
  entries: LsEntry[]
  total: number
  skipped: number
  truncated: boolean
  listedAt: number
}

export interface Info {
  host: string
  cacheDir: string
  cliRoots: string[]
}

export const getScans = () => api<ScanEntry[]>('/api/scans')
export const getInfo = () => api<Info>('/api/info')
export const getLs = (path: string, signal?: AbortSignal) =>
  api<LsResult>(`/api/ls?path=${encodeURIComponent(path)}`, { signal })
export const startScan = (root: string, du: boolean) => apiPost<{ file: string; pid: number }>('/api/scan', { root, du })
export const stopScan = (file: string) => apiPost<{ ok: true }>('/api/stop', { file })
