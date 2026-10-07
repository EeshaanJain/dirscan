import { Tree } from './tree'

export type Mode = 'apparent' | 'du'

/** [dir id, name, bytes, mtime epoch seconds] */
export type LargestFile = [dir: number, name: string, bytes: number, mtime: number]
export type Extensions = Record<string, { files: number; bytes: number }>

export interface Totals {
  bytes: number
  files: number
  dirs: number
  errors: number
}

export interface ScanMeta {
  root: string
  host: string
  mode: Mode
  startedEpoch: number
  scannedEpoch?: number
  durationS?: number
  complete: boolean
  totals?: Totals
}

export interface ScanData {
  meta: ScanMeta
  tree: Tree
  largest: LargestFile[]
  extensions: Extensions
}

const DIR_FIELDS = ['parent', 'name', 'own_bytes', 'own_files', 'total_bytes', 'total_files', 'flags']

/** Raw shape of a format-version-2 snapshot file. */
interface RawSnapshot {
  version: number
  root: string
  host: string
  mode: Mode
  started_epoch?: number
  scanned_epoch?: number
  duration_s?: number
  complete: boolean
  totals: Totals
  dir_fields?: string[]
  dirs: unknown[][]
  largest_files?: unknown[][]
  extensions?: Extensions
}

export function parseSnapshot(text: string): ScanData {
  return buildSnapshot(JSON.parse(text) as RawSnapshot)
}

export function buildSnapshot(raw: RawSnapshot): ScanData {
  if (raw.version !== 2) throw new Error(`unsupported snapshot version ${String(raw.version)}`)
  const fields = raw.dir_fields ?? DIR_FIELDS
  const col = (name: string) => {
    const i = fields.indexOf(name)
    if (i < 0) throw new Error(`snapshot is missing dir field "${name}"`)
    return i
  }
  const cParent = col('parent'), cName = col('name'), cOwnB = col('own_bytes'), cOwnF = col('own_files')
  const cTotB = col('total_bytes'), cTotF = col('total_files'), cFlags = col('flags')

  const rows = raw.dirs
  const n = rows.length
  const tree = new Tree(n)
  const { parent, nextSibling, firstChild, ownBytes, ownFiles, totalBytes, totalFiles, flags, names } = tree
  // Rows come in id order and parents precede children, so sibling lists can be linked in one pass.
  for (let i = 0; i < n; i++) {
    const r = rows[i]
    const p = r[cParent] as number
    parent[i] = p
    names[i] = r[cName] as string
    ownBytes[i] = r[cOwnB] as number
    ownFiles[i] = r[cOwnF] as number
    totalBytes[i] = r[cTotB] as number
    totalFiles[i] = r[cTotF] as number
    flags[i] = r[cFlags] as number
    if (p >= 0) {
      nextSibling[i] = firstChild[p]
      firstChild[p] = i
    }
  }
  tree.n = n
  tree.version++

  return {
    meta: {
      root: raw.root,
      host: raw.host,
      mode: raw.mode,
      startedEpoch: raw.started_epoch ?? 0,
      scannedEpoch: raw.scanned_epoch,
      durationS: raw.duration_s,
      complete: raw.complete,
      totals: raw.totals,
    },
    tree,
    largest: (raw.largest_files ?? []) as LargestFile[],
    extensions: raw.extensions ?? {},
  }
}
