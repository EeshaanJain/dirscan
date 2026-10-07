import { execFileSync } from 'node:child_process'
import path from 'node:path'

// Fixtures come from the real scanner (scripts/make_fixtures.py); it is a no-op when they
// are already up to date with dirscan.py.
export default function setup() {
  execFileSync('python3', [path.resolve(import.meta.dirname, '../scripts/make_fixtures.py')], {
    stdio: 'inherit',
  })
}
