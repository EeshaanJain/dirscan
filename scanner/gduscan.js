#!/usr/bin/env node
// gduscan: dirscan's job (disk usage scan, JSON cache, live event stream) done by gdu.
//
//   node scanner/gduscan.js ROOT [--du] [--rescan] [--quiet] [--cache-dir DIR] [--gdu PATH]
//
// Writes exactly what dirscan.py writes (VIEWER_SPEC.md, format version 2), so the viewer cannot
// tell the engines apart. See plan.js for how a tree is cut into chunks, one gdu run each.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { defaultCacheDir } from '../server/cache.js'
import { CACHE_VERSION, DIR_FIELDS, EventWriter, FLAGS, cacheFileFor, eventsFileFor, readIndex, updateIndex, writeJson } from './cachefile.js'
import { findGdu, gduVersion } from './gdu-bin.js'
import { readGdu } from './gdu-parse.js'
import { DEFAULTS, planChunks } from './plan.js'
import { ScanState } from './state.js'

const USAGE = `gduscan: disk-usage scan with gdu, writing dirscan's cache files and live event stream

  node scanner/gduscan.js ROOT             show a fresh cached scan if there is one, else scan and cache
  node scanner/gduscan.js ROOT --rescan    force a new scan
  node scanner/gduscan.js ROOT --du        allocated blocks (like du) instead of apparent size

options: --cache-dir DIR  --gdu PATH  -q/--quiet  --no-cache  --no-events  --largest N  -o/--out FILE
         --max-age HOURS  --chunk-parallel N (gdu runs at once, default 3)
         --min-chunks N (split the top of the tree until there are this many pieces, default 64)
         --max-entries N  --max-subdirs N (a directory bigger than this is scanned by gdu whole, not split)
`

const BULK_EVERY_MS = 5000
const TICK_MS = 500

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    du: { type: 'boolean', default: false },
    rescan: { type: 'boolean', default: false },
    quiet: { type: 'boolean', short: 'q', default: false },
    'cache-dir': { type: 'string' },
    out: { type: 'string', short: 'o' },
    largest: { type: 'string', default: '1000' },
    'no-cache': { type: 'boolean', default: false },
    'no-events': { type: 'boolean', default: false },
    'max-age': { type: 'string', default: '24' },
    gdu: { type: 'string' },
    'chunk-parallel': { type: 'string', default: '3' },
    'min-chunks': { type: 'string', default: String(DEFAULTS.minChunks) },
    'max-entries': { type: 'string', default: String(DEFAULTS.maxEntries) },
    'max-subdirs': { type: 'string', default: String(DEFAULTS.maxSubdirs) },
    help: { type: 'boolean', short: 'h', default: false },
  },
})
if (args.help) {
  console.log(USAGE)
  process.exit(0)
}

const root = path.resolve(positionals[0] ?? '.')
const mode = args.du ? 'du' : 'apparent'
const cacheDir = path.resolve(args['cache-dir'] ?? defaultCacheDir())
const say = (...a) => args.quiet || console.log(...a)
const die = (msg) => {
  console.error(`gduscan: ${msg}`)
  process.exit(2)
}

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`not a directory: ${root}`)
const gdu = findGdu(args.gdu)
if (!gdu) die('gdu not found (use --gdu PATH or $DIRSCAN_GDU, or install it on $PATH)')

const human = (n) => {
  let v = n
  for (const u of ['B', 'KB', 'MB', 'GB', 'TB', 'PB']) {
    if (v < 1024) return `${v.toFixed(1)} ${u}`
    v /= 1024
  }
  return `${v.toFixed(1)} EB`
}

const cacheFile = args['no-cache'] ? null : args.out ? path.resolve(args.out) : cacheFileFor(root, mode, cacheDir)
const eventsFile = cacheFile && !args['no-events'] ? eventsFileFor(cacheFile) : null

// ------------------------------------------------------------------ a fresh cached scan is enough
if (cacheFile && !args.rescan) {
  try {
    const snap = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    const ageH = (Date.now() / 1000 - snap.scanned_epoch) / 3600
    if (snap.version === CACHE_VERSION && snap.complete && ageH <= Number(args['max-age'])) {
      say(`Cached scan of ${root}  (${ageH.toFixed(1)}h ago; --rescan to refresh)`)
      say(`  ${snap.totals.files.toLocaleString()} files · ${snap.totals.dirs.toLocaleString()} dirs · ${human(snap.totals.bytes)}`)
      say(`  cache: ${cacheFile}`)
      process.exit(0)
    }
  } catch {
    // no usable cache: scan
  }
}

// ------------------------------------------------------------------ scan
const start = Date.now()
const host = os.hostname()
const state = new ScanState({ rootName: path.basename(root) || root, largest: Number(args.largest) })
const ev = eventsFile ? new EventWriter(eventsFile) : null
const emit = (...rec) => ev?.emit(...rec)

let interrupted = false
let failedChunks = 0
let currentPath = root
const children = new Set()
let lastBulk = 0

const bulk = () => {
  emit('L', state.largestList())
  emit('x', state.extensions())
}
const tick = () => {
  const now = Date.now()
  emit('p', state.filesSeen, state.dirsVisited, state.bytesSeen, state.errors, Math.round((now - start) / 100) / 10, currentPath)
  if (now - lastBulk >= BULK_EVERY_MS) {
    bulk()
    lastBulk = now
  }
  ev?.flush()
}

if (ev) {
  emit('h', {
    version: CACHE_VERSION, root, host, mode, pid: process.pid, started_epoch: Math.floor(start / 1000), cache_file: cacheFile,
    dir_fields: DIR_FIELDS, flags: FLAGS,
  })
  emit('n', 0, -1, state.name[0])
  ev.flush()
}
if (cacheFile) {
  try {
    updateIndex(cacheFile, {
      root, host, mode, pid: process.pid, started_epoch: Math.floor(start / 1000), in_progress: true, complete: false, events: eventsFile,
    })
  } catch {
    // the cache dir may be read-only: scanning still works
  }
}

// The first signal stops the scan and still writes a partial snapshot; repeats are ignored,
// because interrupting the write itself is how a snapshot gets lost.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (interrupted) return
    interrupted = true
    for (const c of children) c.kill('SIGTERM')
  })
}

const work = fs.mkdtempSync(path.join(cacheDir && fs.existsSync(cacheDir) ? cacheDir : os.tmpdir(), '.gduscan-'))
const emptyConfig = path.join(work, 'gdu.yaml')
fs.writeFileSync(emptyConfig, '') // not the user's ~/.gdu.yaml: its flags could change what is exported

const timer = setInterval(tick, TICK_MS)

/** Paths gdu could not open, from its log: `msg="open /a/b: permission denied"`. */
function readLog(file) {
  const denied = new Set()
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { denied }
  }
  for (const line of text.split('\n')) {
    const m = /msg="((?:[^"\\]|\\.)*)"/.exec(line)
    if (!m) continue
    const msg = m[1].replace(/\\(["\\])/g, '$1')
    const colon = msg.lastIndexOf(': ')
    const verb = /^(open|lstat|stat|readdir|read|readlink) /.exec(msg)
    if (!verb || colon < 0) continue
    denied.add(msg.slice(verb[0].length, colon))
  }
  return { denied }
}

class Stopped extends Error {}

/** Turn one finished gdu export into dir table rows and events. */
async function importChunk(chunk, exportFile, logFile) {
  const { denied } = readLog(logFile)
  const stack = []
  let matched = 0
  const join = (a, b) => (a === '/' ? `/${b}` : `${a}/${b}`)
  const r = await readGdu(exportFile, {
    dir(entry) {
      if (interrupted) throw new Stopped()
      if (!stack.length) {
        stack.push({ id: chunk.id, path: chunk.path, bytes: 0, files: 0 }) // the chunk's own root
        return
      }
      const parent = stack[stack.length - 1]
      const id = state.addDir(parent.id, entry.name)
      emit('n', id, parent.id, entry.name)
      stack.push({ id, path: join(parent.path, entry.name), bytes: 0, files: 0 })
    },
    file(entry) {
      if (entry.notreg) return // symlinks and other non-regular files are not counted
      const f = stack[stack.length - 1]
      const size = (args.du ? entry.dsize : entry.asize) ?? 0
      f.bytes += size
      f.files++
      state.noteFile(f.id, entry.name, size, entry.mtime ?? 0)
    },
    close() {
      const f = stack.pop()
      const unreadable = denied.has(f.path)
      if (unreadable) {
        state.errors++
        matched++
      }
      state.visit(f.id, f.bytes, f.files, unreadable)
      emit('s', f.id, f.bytes, f.files, state.flags[f.id])
    },
  })
  if (r.depthLeft) throw new Error(`gdu export for ${chunk.path} is cut off`)
  // errors gdu logged for something that is not a directory of this chunk (an unreadable file, say)
  state.errors += Math.max(0, denied.size - matched)
}

function runGdu(chunk, i) {
  const exportFile = path.join(work, `c${i}.json`)
  const logFile = path.join(work, `c${i}.log`)
  return new Promise((resolve) => {
    const child = spawn(
      gdu,
      ['-n', '-p', '-c', '--config-file', emptyConfig, '--output-attrs', 'name,asize,dsize,mtime,notreg', '-l', logFile, '-o', exportFile, chunk.path],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    children.add(child)
    let err = ''
    child.stderr.on('data', (d) => {
      if (err.length < 2000) err += d
    })
    child.on('error', (e) => resolve({ ok: false, why: e.message }))
    child.on('close', (code, signal) => {
      children.delete(child)
      resolve(code === 0 ? { ok: true, exportFile, logFile } : { ok: false, why: `gdu exited ${code ?? signal}: ${err.trim()}` })
    })
  })
}

let importChain = Promise.resolve()
try {
  say(`Scanning ${root} with gdu (${mode})…`)
  const chunks = await planChunks({
    root, state, emit, du: args.du, stopped: () => interrupted, minChunks: Number(args['min-chunks']),
    maxEntries: Number(args['max-entries']), maxSubdirs: Number(args['max-subdirs']),
  })
  let next = 0
  const worker = async () => {
    while (!interrupted && next < chunks.length) {
      const i = next++
      const chunk = chunks[i]
      currentPath = chunk.path
      const r = await runGdu(chunk, i)
      if (interrupted) break
      if (!r.ok) {
        failedChunks++
        state.errors++
        console.error(`gduscan: ${chunk.path}: ${r.why}`)
        continue
      }
      // imports run one at a time: they all mutate the same table and event stream
      importChain = importChain.then(() => importChunk(chunk, r.exportFile, r.logFile)).catch((e) => {
        if (e instanceof Stopped) return
        failedChunks++
        console.error(`gduscan: ${chunk.path}: ${e.message}`)
      })
      await importChain
      fs.rmSync(r.exportFile, { force: true })
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Number(args['chunk-parallel'])) }, worker))
  await importChain
} catch (e) {
  if (!(e instanceof Stopped)) {
    failedChunks++
    console.error(`gduscan: ${e.stack ?? e}`)
  }
} finally {
  clearInterval(timer)
  fs.rmSync(work, { recursive: true, force: true })
  state.finalize()
  const now = Date.now()
  const complete = !interrupted && failedChunks === 0
  const totals = { bytes: state.bytesSeen, files: state.filesSeen, dirs: state.dirCount, errors: state.errors }
  if (cacheFile) {
    try {
      const snap = {
        version: CACHE_VERSION,
        tool: 'gduscan.js',
        engine: { name: 'gdu', version: gduVersion(gdu) },
        root, host, mode,
        scanned_at: new Date(now).toISOString().replace(/\.\d+Z$/, '+00:00'),
        started_epoch: Math.floor(start / 1000),
        scanned_epoch: Math.floor(now / 1000),
        duration_s: Math.round((now - start) / 10) / 100,
        complete,
        totals,
        dir_fields: DIR_FIELDS,
        flags: FLAGS,
        dirs: state.rows(),
        file_fields: ['dir', 'name', 'bytes', 'mtime'],
        largest_files: state.largestList(),
        extensions: state.extensions(),
      }
      writeJson(cacheFile, snap)
      updateIndex(cacheFile, {
        root, host, mode, scanned_at: snap.scanned_at, started_epoch: snap.started_epoch, scanned_epoch: snap.scanned_epoch,
        duration_s: snap.duration_s, complete, bytes: totals.bytes, files: totals.files, dirs: totals.dirs, in_progress: false, events: eventsFile,
      })
    } catch (e) {
      console.error(`gduscan: could not write the cache: ${e.message}`)
    }
  }
  if (ev) {
    bulk()
    emit('e', { complete, duration_s: Math.round((now - start) / 10) / 100, cache_file: cacheFile, totals })
    ev.close()
  }
  say(`${complete ? 'Scanned' : 'Partial scan of'} ${root}`)
  say(`  ${totals.files.toLocaleString()} files · ${totals.dirs.toLocaleString()} dirs · ${human(totals.bytes)} · ${((now - start) / 1000).toFixed(1)}s${totals.errors ? ` · ${totals.errors} unreadable` : ''}`)
  if (cacheFile) say(`  cache: ${cacheFile}${complete ? '' : '  (partial)'}`)
}
