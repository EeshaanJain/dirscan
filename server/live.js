// GET /api/live: Server-Sent Events that tail a scan's events file.
//
// Each SSE message is a JSON array of event lines (the lines of the .ndjson file, already
// valid JSON, joined into one array without re-parsing). A client that connects mid-scan
// receives the file from offset 0 in batches, then follows it. After the `e` event the stream
// is closed.

import { Tailer } from './tail.js'

export const MAX_BATCH_LINES = 5000
const MAX_BATCH_BYTES = 2 << 20
const KEEPALIVE_MS = 15_000
/** after the scan stops being "running", how long to wait for its last lines (`e`) to land */
const GRACE_MS = 3000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Split lines into SSE-sized batches; bad lines are dropped rather than poisoning a batch. */
export function* batches(lines, maxLines = MAX_BATCH_LINES, maxBytes = MAX_BATCH_BYTES) {
  let cur = []
  let bytes = 0
  for (const l of lines) {
    if (l.charCodeAt(0) !== 0x5b /* [ */ || l.charCodeAt(l.length - 1) !== 0x5d /* ] */) continue
    if (cur.length && (cur.length >= maxLines || bytes + l.length > maxBytes)) {
      yield '[' + cur.join(',') + ']'
      cur = []
      bytes = 0
    }
    cur.push(l)
    bytes += l.length + 1
  }
  if (cur.length) yield '[' + cur.join(',') + ']'
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{eventsFile: string, getState: () => Promise<string>, pollMs?: number}} opts
 */
export async function streamLive(req, res, { eventsFile, getState, pollMs = 300 }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')

  let closed = false
  req.on('close', () => {
    closed = true
  })
  const keepalive = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n')
  }, KEEPALIVE_MS)

  const send = async (data, event) => {
    const msg = (event ? `event: ${event}\n` : '') + `data: ${data}\n\n`
    if (!res.write(msg) && !closed) {
      await new Promise((resolve) => {
        const done = () => {
          res.off('drain', done)
          req.off('close', done)
          resolve()
        }
        res.once('drain', done)
        req.once('close', done)
      })
    }
  }

  const tailer = new Tailer(eventsFile)
  let quietSince = 0
  try {
    while (!closed) {
      const { lines, eof, missing } = await tailer.read()

      // stop after the `e` event, whatever follows it
      const endAt = lines.findIndex((l) => l.startsWith('["e",'))
      const out = endAt >= 0 ? lines.slice(0, endAt + 1) : lines
      for (const b of batches(out)) {
        if (closed) break
        await send(b)
      }
      if (endAt >= 0) break
      if (!eof) continue // more to read right now (catching up)

      // Caught up. Keep following while the scan runs; if it stopped without an `e`
      // (SIGKILL), or the file never appeared, say so instead of waiting forever.
      const state = await getState()
      if (state === 'running') {
        quietSince = 0
      } else {
        // the first quiet pass only starts the clock: the next read picks up anything flushed
        // between the last read and the scanner's death
        const first = !quietSince
        quietSince ||= Date.now()
        if (!first && Date.now() - quietSince >= (state === 'abandoned' || missing ? 0 : GRACE_MS)) {
          await send(JSON.stringify({ state, missing }), 'closed')
          break
        }
      }
      await sleep(pollMs)
    }
  } catch (e) {
    if (!closed) await send(JSON.stringify({ error: e.message, code: e.code }), 'error').catch(() => {})
  } finally {
    clearInterval(keepalive)
    res.end()
  }
}
