// Minimal Server-Sent Events parser. EventSource cannot send the auth header the API
// requires, so the client reads the stream with fetch() and parses it here.

export interface SseMessage {
  event: string
  data: string
}

export class SseParser {
  private buf = ''
  private event = 'message'
  private data: string[] = []

  /** Feed a decoded chunk; returns the messages completed by it. */
  push(chunk: string): SseMessage[] {
    this.buf += chunk
    const out: SseMessage[] = []
    let at: number
    // a line ends at \n, \r\n or a lone \r (a trailing \r may be half of \r\n: wait for more)
    while ((at = this.buf.search(/\r\n|\n|\r(?!$)/)) >= 0) {
      const m = /^(\r\n|\n|\r)/.exec(this.buf.slice(at, at + 2))!
      const line = this.buf.slice(0, at)
      this.buf = this.buf.slice(at + m[0].length)
      if (line === '') {
        if (this.data.length) out.push({ event: this.event, data: this.data.join('\n') })
        this.event = 'message'
        this.data = []
      } else if (line.startsWith(':')) {
        // comment / keepalive
      } else {
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') this.event = value || 'message'
        else if (field === 'data') this.data.push(value)
      }
    }
    return out
  }
}

/** Read a fetch Response body as SSE until it ends or `signal` aborts. */
export async function readSse(res: Response, onMessage: (m: SseMessage) => void): Promise<void> {
  if (!res.body) throw new Error('response has no body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    for (const m of parser.push(decoder.decode(value, { stream: true }))) onMessage(m)
  }
}
