import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GduFormatError, parseLine, readGdu } from '../scanner/gdu-parse.js'
import { tmpDir } from './server-helpers'

const walk = async (text: string) => {
  const f = path.join(tmpDir('gdu-parse-'), 'x.json')
  fs.writeFileSync(f, text)
  const log: string[] = []
  const r = await readGdu(f, {
    dir: (e: any) => log.push(`+${e.name}`),
    file: (e: any) => log.push(`${e.name}${e.notreg ? '~' : ''}:${e.asize ?? 0}`),
    close: () => log.push('-'),
  })
  return { log, ...r }
}

describe('gdu export parser', () => {
  it('parses lines: opens, entries, closers', () => {
    expect(parseLine('[{"name":"a","asize":5}')).toEqual({ open: true, entry: { name: 'a', asize: 5 }, closes: 0 })
    expect(parseLine('{"name":"f","asize":3},')).toEqual({ open: false, entry: { name: 'f', asize: 3 }, closes: 0 })
    expect(parseLine('{"name":"f"}]]]')).toEqual({ open: false, entry: { name: 'f' }, closes: 3 })
    expect(parseLine(']]')).toEqual({ open: false, entry: null, closes: 2 })
    expect(parseLine('],')).toEqual({ open: false, entry: null, closes: 1 })
  })

  it('names containing quotes, brackets and braces do not confuse it', () => {
    const e = parseLine('{"name":"we\\"ird]},name","asize":1}]')
    expect(e.entry).toEqual({ name: 'we"ird]},name', asize: 1 })
    expect(e.closes).toBe(1)
    expect((parseLine('[{"name":"d]ir{","asize":1}').entry as { name: string }).name).toBe('d]ir{')
  })

  it('rejects garbage rather than guessing', () => {
    expect(() => parseLine('hello')).toThrow(GduFormatError)
    expect(() => parseLine('{"name":"x"} trailing')).toThrow(GduFormatError)
    expect(() => parseLine('{"name":}')).toThrow(GduFormatError)
    expect(() => parseLine('[,')).toThrow(GduFormatError)
  })

  it('walks a real-shaped export (gdu v5.37 output)', async () => {
    const text = [
      '[1,2,{"progname":"gdu","progver":"v5.37.0","timestamp":1},',
      '[{"name":"/r","asize":5517,"dsize":12288},',
      '{"name":"f1","asize":3,"dsize":4096},',
      '{"name":"lnk","asize":2,"notreg":true},',
      '[{"name":"c","asize":0},',
      '{"name":"old"}],',
      '[{"name":"a","asize":5512},',
      '{"name":"x.bin","asize":5000},',
      '[{"name":"b","asize":512}',
      ']]]]',
    ].join('\n')
    const { log, depthLeft } = await walk(text)
    expect(log).toEqual(['+/r', 'f1:3', 'lnk~:2', '+c', 'old:0', '-', '+a', 'x.bin:5000', '+b', '-', '-', '-'])
    expect(depthLeft).toBe(0)
  })

  it('reports a cut-off export (killed mid-write) instead of pretending it is whole', async () => {
    const { depthLeft } = await walk('[1,2,{},\n[{"name":"/r"},\n{"name":"f","asize":1},\n[{"name":"d"},\n{"name":"g","asize":2},\n')
    expect(depthLeft).toBe(2)
  })

  it('handles a header-only or empty file', async () => {
    expect((await walk('[1,2,{},\n')).log).toEqual([])
    expect((await walk('')).log).toEqual([])
  })
})
