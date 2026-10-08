#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseCli, USAGE } from './args.js'
import { REPO_ROOT, startServer } from './start.js'

function openBrowser(url) {
  const { platform, env } = process
  // The URL carries the access token and process arguments are readable by other users on a
  // shared node, so the browser is pointed at a private (0700) local page that redirects to it.
  let target = url
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dirscan-view-'))
    const page = path.join(dir, 'open.html')
    fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`, { mode: 0o600 })
    target = page
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 60_000).unref()
  } catch {
    return // no private place to put it: print-only is safer than leaking the token
  }
  // On a remote login node there is no browser worth opening (the user tunnels in instead).
  if (platform === 'linux' && (!(env.DISPLAY || env.WAYLAND_DISPLAY) || env.SSH_CONNECTION)) return
  const [cmd, args] =
    platform === 'darwin' ? ['open', [target]] : platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]] : ['xdg-open', [target]]
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    p.on('error', () => {})
    p.unref()
  } catch {
    // opening is a convenience only
  }
}

async function main() {
  let opts
  try {
    opts = parseCli(process.argv.slice(2), REPO_ROOT)
  } catch (e) {
    console.error(`dirscan-view: ${e.message}\n\n${USAGE}`)
    process.exit(2)
  }
  if (opts.help) return console.log(USAGE)
  const { server, port, token, route, notes, scanner } = await startServer(opts)
  if (scanner.name === 'python' && !fs.existsSync(opts.scanner)) {
    console.error(`warning: scanner not found at ${opts.scanner}; starting scans from the viewer will fail`)
  }

  const url = `http://127.0.0.1:${port}/?token=${token}${route}`
  for (const n of notes) console.log(n)
  console.log(`\n  dirscan-view  ${url}\n`)
  console.log(`  on a remote machine? from your laptop:  ssh -L ${port}:127.0.0.1:${port} ${os.hostname()}`)
  console.log(`  then open the URL above in your local browser.\n`)
  console.log(`  scanner: ${scanner.name} ${scanner.detail}`)
  console.log(`  cache: ${opts.cacheDir}   (Ctrl-C stops the viewer; scans it started keep running)\n`)
  if (opts.open) openBrowser(url)

  const stop = () => {
    server.close(() => process.exit(0))
    server.closeAllConnections?.()
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((e) => {
  console.error(`dirscan-view: ${e.message}`)
  process.exit(1)
})
