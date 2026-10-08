import path from 'node:path'
import { parseArgs } from 'node:util'
import { defaultCacheDir } from './cache.js'

export const USAGE = `dirscan-view: local web viewer for dirscan.py

  npm start                          dashboard of all scans in the cache
  npm start -- <path>                open the running scan of <path>, else its newest snapshot
  npm start -- <path> --scan [--du]  start a fresh scan of <path> and follow it live
  npm start -- <snapshot.json>       open a specific snapshot file

options:
  --port <n>         port to listen on (default 4173; if unset, the next free port is used)
  --host <addr>      loopback address to bind (default 127.0.0.1; others are refused)
  --no-open          don't try to open a browser
  --cache-dir <dir>  dirscan cache dir (default $XDG_CACHE_HOME/dirscan or ~/.cache/dirscan)
  --engine <name>    scanner for scans started here: gdu, python, or auto (default: gdu if found, else python)
  --gdu <path>       the gdu binary (default: $DIRSCAN_GDU, then gdu on $PATH)
  --scanner <file>   dirscan.py for the python engine (default: the one next to this repo)
  --python <cmd>     python interpreter for the python engine (default python3)
  -h, --help
`

/** @param {string[]} argv @param {string} repoRoot */
export function parseCli(argv, repoRoot) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
      'no-open': { type: 'boolean', default: false },
      'cache-dir': { type: 'string' },
      engine: { type: 'string', default: 'auto' },
      gdu: { type: 'string' },
      scanner: { type: 'string' },
      python: { type: 'string', default: 'python3' },
      scan: { type: 'boolean', default: false },
      du: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (!['auto', 'gdu', 'python'].includes(values.engine)) throw new Error(`bad --engine: ${values.engine} (gdu, python or auto)`)
  if (positionals.length > 1) throw new Error('at most one <path> argument is accepted')
  if (values.scan && !positionals.length) throw new Error('--scan needs a <path>')

  let port = 4173
  let portFixed = false
  if (values.port !== undefined) {
    port = Number(values.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad --port: ${values.port}`)
    portFixed = true
  }
  if (!isLoopback(values.host)) {
    throw new Error(`refusing to bind ${values.host}: dirscan-view only listens on loopback (use an SSH tunnel)`)
  }
  return {
    target: positionals[0],
    scan: values.scan,
    du: values.du,
    port,
    portFixed,
    host: values.host,
    open: !values['no-open'],
    cacheDir: path.resolve(values['cache-dir'] ?? defaultCacheDir()),
    engine: values.engine,
    gdu: values.gdu,
    scanner: path.resolve(values.scanner ?? path.join(repoRoot, 'dirscan.py')),
    python: values.python,
    help: values.help,
  }
}

export function isLoopback(host) {
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
}
