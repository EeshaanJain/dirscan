// `npm run dev`: API server on 127.0.0.1:4174 plus the Vite dev server (which proxies /api to it).
// Accepts the same arguments as `npm start`.
import crypto from 'node:crypto'
import os from 'node:os'
import { createServer } from 'vite'
import { parseCli, USAGE } from './args.js'
import { REPO_ROOT, startServer } from './start.js'

const API_PORT = 4174
const VITE_PORT = 5173

let opts
try {
  opts = parseCli(process.argv.slice(2), REPO_ROOT)
} catch (e) {
  console.error(`dirscan-view: ${e.message}\n\n${USAGE}`)
  process.exit(2)
}
opts.port = API_PORT
opts.portFixed = true

const token = crypto.randomBytes(24).toString('base64url')
const { route, notes } = await startServer(opts, { token })
const vite = await createServer({ root: REPO_ROOT, server: { host: '127.0.0.1', port: VITE_PORT } })
await vite.listen()
const port = vite.httpServer.address().port

for (const n of notes) console.log(n)
console.log(`\n  dirscan-view (dev)  http://127.0.0.1:${port}/?token=${token}${route}\n`)
console.log(`  API on 127.0.0.1:${API_PORT}; tunnel with: ssh -L ${port}:127.0.0.1:${port} ${os.hostname()}\n`)
