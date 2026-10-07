#!/usr/bin/env node
// Synthetic format-2 snapshot generator, for load-time checks.
//
//   node scripts/synthetic.mjs [--dirs 1000000] [--seed 1] [--out fixtures/synthetic-1m.json]
//
// Builds a plausible tree (deep chains plus wide fan-out), with consistent own/total
// numbers, and writes it in the exact shape dirscan.py produces.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** @returns {string} snapshot JSON text */
export function generateSnapshotJSON({ dirs: n = 1_000_000, seed = 1 } = {}) {
  const rnd = mulberry32(seed)
  const parent = new Int32Array(n)
  const ownB = new Float64Array(n)
  const ownF = new Float64Array(n)
  parent[0] = -1
  for (let i = 1; i < n; i++) {
    // half the dirs hang off a recent dir (long chains), half off any earlier dir (fan-out);
    // the first 40 dirs hang off the root so the top level is not a single chain
    parent[i] = i < 40 ? 0 : rnd() < 0.5 ? Math.max(0, i - 1 - Math.floor(rnd() * 40)) : Math.floor(rnd() * i)
  }
  for (let i = 0; i < n; i++) {
    ownF[i] = Math.floor(rnd() * rnd() * 40)
    ownB[i] = ownF[i] ? Math.floor(Math.exp(rnd() * 14) * ownF[i]) : 0
  }
  const totB = Float64Array.from(ownB)
  const totF = Float64Array.from(ownF)
  for (let i = n - 1; i > 0; i--) {
    totB[parent[i]] += totB[i]
    totF[parent[i]] += totF[i]
  }

  const rows = new Array(n)
  for (let i = 0; i < n; i++) {
    const name = i === 0 ? 'synthetic' : `d${i.toString(36)}${i % 11 === 0 ? ' x' : ''}`
    rows[i] = `[${parent[i]},${JSON.stringify(name)},${ownB[i]},${ownF[i]},${totB[i]},${totF[i]},${i % 997 === 5 ? 7 : 6}]`
  }

  // top files and extensions, roughly consistent with the tree
  const largest = []
  for (let k = 0; k < 1000; k++) {
    const dir = Math.floor(rnd() * n)
    largest.push(`[${dir},"big${k}.pt",${Math.floor(1e10 / (k + 1))},${1_700_000_000 + k}]`)
  }
  const exts = { '.py': 0.1, '.pt': 0.6, '.npy': 0.2, '[no ext]': 0.1 }
  const extJson = JSON.stringify(
    Object.fromEntries(Object.entries(exts).map(([e, f]) => [e, { files: Math.floor(totF[0] * f), bytes: Math.floor(totB[0] * f) }])),
  )
  return (
    `{"version":2,"tool":"dirscan.py","root":"/synthetic","host":"node01","mode":"apparent",` +
    `"scanned_at":"2026-10-07T00:00:00+00:00","started_epoch":1791374000,"scanned_epoch":1791374400,"duration_s":400,` +
    `"complete":true,"totals":{"bytes":${totB[0]},"files":${totF[0]},"dirs":${n},"errors":0},` +
    `"dir_fields":["parent","name","own_bytes","own_files","total_bytes","total_files","flags"],` +
    `"flags":{"unreadable":1,"visited":2,"complete":4},"dirs":[${rows.join(',')}],` +
    `"file_fields":["dir","name","bytes","mtime"],"largest_files":[${largest.join(',')}],"extensions":${extJson}}`
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 ? process.argv[i + 1] : dflt
  }
  const dirs = Number(arg('dirs', 1_000_000))
  const out = path.resolve(arg('out', `fixtures/synthetic-${dirs >= 1e6 ? dirs / 1e6 + 'm' : dirs / 1e3 + 'k'}.json`))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const t = Date.now()
  fs.writeFileSync(out, generateSnapshotJSON({ dirs, seed: Number(arg('seed', 1)) }))
  console.log(`wrote ${dirs.toLocaleString()} dirs to ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${Date.now() - t} ms)`)
}
