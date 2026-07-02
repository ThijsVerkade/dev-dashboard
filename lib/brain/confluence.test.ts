import { describe, it, expect } from 'vitest'
import { parsePageId, fetchConfluencePage, type ConfluenceCreds } from './confluence'

const creds: ConfluenceCreds = { host: 'https://acme.atlassian.net', email: 'a@b.co', token: 't' }

describe('parsePageId', () => {
  it('accepts a bare id', () => expect(parsePageId('123456')).toBe('123456'))
  it('extracts id from a url', () =>
    expect(parsePageId('https://acme.atlassian.net/wiki/spaces/ENG/pages/234567/ADR-6')).toBe('234567'))
  it('returns null for garbage', () => expect(parsePageId('nope')).toBeNull())
})

describe('fetchConfluencePage', () => {
  it('fetches and returns title + storage html + source url', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          id: '234567',
          title: 'ADR-6 Merge commits',
          body: { storage: { value: '<p>Body</p>' } },
          _links: { webui: '/spaces/ENG/pages/234567/ADR-6' },
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const res = await fetchConfluencePage(creds, '234567', fakeFetch)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.title).toBe('ADR-6 Merge commits')
      expect(res.data.html).toBe('<p>Body</p>')
      expect(res.data.sourceUrl).toBe('https://acme.atlassian.net/wiki/spaces/ENG/pages/234567/ADR-6')
    }
  })

  it('fails cleanly on HTTP 404', async () => {
    const fakeFetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    const res = await fetchConfluencePage(creds, '999', fakeFetch)
    expect(res.ok).toBe(false)
  })
})
