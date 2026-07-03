import { describe, it, expect } from 'vitest'
import { normalizeObsidianHost, validateObsidianToken } from './obsidian'

const resp = (status: number): Response => ({ ok: status < 400, status }) as Response

describe('normalizeObsidianHost', () => {
  it('trims whitespace and strips trailing slashes', () => {
    expect(normalizeObsidianHost('  http://127.0.0.1:27123//  ')).toBe('http://127.0.0.1:27123')
  })
})

describe('validateObsidianToken', () => {
  it('requires both host and token', async () => {
    expect((await validateObsidianToken('', 'k', async () => resp(200))).ok).toBe(false)
    expect((await validateObsidianToken('http://x', '', async () => resp(200))).ok).toBe(false)
  })

  it('hits GET /vault/ with a Bearer header and succeeds on 200', async () => {
    let seenUrl = ''
    let seenAuth: string | undefined
    const r = await validateObsidianToken('http://127.0.0.1:27123', 'key', async (url, init) => {
      seenUrl = url
      seenAuth = (init?.headers as Record<string, string>)?.Authorization
      return resp(200)
    })
    expect(r.ok).toBe(true)
    expect(seenUrl).toBe('http://127.0.0.1:27123/vault/')
    expect(seenAuth).toBe('Bearer key')
  })

  it('fails with a "wrong API key" hint on 401', async () => {
    const r = await validateObsidianToken('http://x', 'bad', async () => resp(401))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('wrong API key')
  })

  it('fails gracefully when the server is unreachable', async () => {
    const r = await validateObsidianToken('http://x', 'k', async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('Could not reach')
  })
})
