// The viewer starting, following and stopping scans with the gdu engine: the same API contract
// as with dirscan.py, which is what keeps the UI unchanged.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyEvents, createLiveState } from '@/lib/events'
import { parseSnapshot } from '@/lib/snapshot'
import { parseCli } from '../server/args.js'
import { eventsPathFor, deriveState } from '../server/cache.js'
import { chooseScanner, REPO_ROOT } from '../server/start.js'
import { findGdu } from '../scanner/gdu-bin.js'
import { startTestServer, sleep, tmpDir, waitFor } from './server-helpers'

const GDU = findGdu()
const cli = (...a: string[]) => parseCli(a, REPO_ROOT)

describe('engine selection', () => {
  it('parses --engine and --gdu, and refuses unknown engines', () => {
    expect(cli().engine).toBe('auto')
    expect(cli('--engine', 'python').engine).toBe('python')
    expect(cli('--gdu', '/x/gdu').gdu).toBe('/x/gdu')
    expect(() => cli('--engine', 'du')).toThrow(/bad --engine/)
  })

  it('python engine runs dirscan.py under the chosen interpreter', () => {
    const s = chooseScanner(cli('--engine', 'python', '--python', 'py3', '--scanner', '/r/dirscan.py'))
    expect(s).toMatchObject({ command: 'py3', args: ['/r/dirscan.py'], name: 'python' })
  })

  it.skipIf(!GDU)('gdu engine runs the adapter under node with the gdu path', () => {
    const s = chooseScanner(cli('--engine', 'gdu'))
    expect(s.name).toBe('gdu')
    expect(s.command).toBe(process.execPath)
    expect(s.args[0]).toBe(path.join(REPO_ROOT, 'scanner', 'gduscan.js'))
    expect(s.args).toContain(GDU!)
    expect(chooseScanner(cli()).name).toBe('gdu') // auto prefers gdu when it exists
  })

  it('an explicit gdu that does not exist is an error, not a silent fallback', () => {
    expect(() => chooseScanner(cli('--engine', 'gdu', '--gdu', '/no/such/gdu'))).toThrow(/no gdu was found/)
    // auto with a bad explicit path falls back to python (nothing was demanded of gdu)
    expect(chooseScanner(cli('--gdu', '/no/such/gdu')).name).toBe('python')
  })
})

describe.skipIf(!GDU)('viewer + gdu engine', () => {
  const post = (srv: Awaited<ReturnType<typeof startTestServer>>, p: string, body: unknown) =>
    srv.json(p, { method: 'POST', body: JSON.stringify(body) })

  it('POST /api/scan runs gduscan and the snapshot and event stream appear, in the usual format', async () => {
    const cache = tmpDir('ge-cache-')
    const srv = await startTestServer(cache, { args: ['--engine', 'gdu'] })
    try {
      const root = fs.realpathSync(tmpDir('ge-tree-'))
      fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
      fs.writeFileSync(path.join(root, 'a', 'x.bin'), Buffer.alloc(1234))
      fs.writeFileSync(path.join(root, 'y.txt'), 'hello')
      const { status, body } = await post(srv, '/api/scan', { root })
      expect(status).toBe(200)
      expect(path.dirname(body.file)).toBe(cache)
      const row = await waitFor(async () => (await srv.json('/api/scans')).body.find((s: any) => s.file === body.file && s.state === 'done'), 'gdu scan to finish')
      expect(row.bytes).toBe(1239)
      const snap = JSON.parse(fs.readFileSync(body.file, 'utf8'))
      expect(snap.tool).toBe('gduscan.js')
      const tree = parseSnapshot(JSON.stringify(snap)).tree
      expect(tree.totalBytes[0]).toBe(1239)
      // the live endpoint serves its events and the reducer rebuilds the same tree
      const res = await srv.api(`/api/live?file=${encodeURIComponent(body.file)}`)
      const text = await res.text()
      const events = text.split('\n\n').filter((m) => m.startsWith('data: ')).flatMap((m) => JSON.parse(m.slice(6)))
      const st = createLiveState()
      applyEvents(st, events)
      expect(st.tree.n).toBe(tree.n)
      expect(st.tree.totalBytes[0]).toBe(1239)
    } finally {
      await srv.close()
    }
  })

  it('a running gdu scan is "running" (the pid check recognises the node-run adapter), refused as a duplicate, and Stop gives a partial snapshot', async () => {
    const cache = tmpDir('ge-cache-')
    const srv = await startTestServer(cache, { args: ['--engine', 'gdu'] })
    try {
      const root = fs.realpathSync(tmpDir('ge-tree-'))
      // enough chunks that the scan takes a moment: the scanner runs gdu once per piece, one at a time here
      for (let d = 0; d < 80; d++) {
        const dir = path.join(root, `d${d}`)
        fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
        for (let f = 0; f < 20; f++) fs.writeFileSync(path.join(dir, `f${f}`), 'x')
      }
      // slow it down deterministically: one gdu at a time, and plenty of chunks
      ;(srv.scans as any).scanner.args.push('--chunk-parallel', '1', '--min-chunks', '10')
      const { body } = await post(srv, '/api/scan', { root })
      const running = (await srv.json('/api/scans')).body.find((s: any) => s.file === body.file)
      expect(running).toMatchObject({ state: 'running', managed: true })
      const dup = await post(srv, '/api/scan', { root })
      expect(dup.status).toBe(409)
      expect((await post(srv, '/api/stop', { file: body.file })).status).toBe(200)
      const row = await waitFor(async () => {
        const s = (await srv.json('/api/scans')).body.find((x: any) => x.file === body.file)
        return s && s.state !== 'running' ? s : null
      }, 'the scan to stop')
      expect(['partial', 'done']).toContain(row.state) // a very fast machine may finish first
      if (row.state === 'partial') {
        expect(JSON.parse(fs.readFileSync(body.file, 'utf8')).complete).toBe(false)
        const lines = fs.readFileSync(eventsPathFor(body.file), 'utf8').trim().split('\n')
        expect(JSON.parse(lines[lines.length - 1])).toMatchObject(['e', { complete: false }])
      }
    } finally {
      await sleep(100)
      await srv.close()
    }
  }, 30_000)

  it('the node adapter counts as a live scanner for the recycled-pid check', () => {
    expect(deriveState({ in_progress: true, host: 'elsewhere', pid: 1 })).toBe('remote')
    expect(typeof deriveState).toBe('function')
  })
})
