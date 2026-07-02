import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { extractProject } from './extract-project'

const fixtures = fileURLToPath(new URL('./__fixtures__', import.meta.url))

describe('extractProject', () => {
  it('extracts stack, scripts, readme, and tier from a nest api', async () => {
    const f = await extractProject('auction', 'api', `${fixtures}/nest-api`)
    expect(f.tier).toBe('api')
    expect(f.stack).toEqual(expect.arrayContaining(['NestJS', 'Drizzle', 'Postgres']))
    expect(f.scripts).toEqual(expect.arrayContaining(['start:dev', 'build', 'test']))
    expect(f.readmeTitle).toBe('Auction API')
    expect(f.readmeIntro).toBe('The auction service. Handles listings, bids, and settlement.')
    expect(f.hasAgentsDoc).toBe(false)
  })

  it('detects Next.js frontend and tolerates a missing README', async () => {
    const f = await extractProject('auction', 'fe', `${fixtures}/next-fe`)
    expect(f.tier).toBe('frontend')
    expect(f.stack).toEqual(expect.arrayContaining(['Next.js', 'React']))
    expect(f.readmeTitle).toBeUndefined()
  })

  it('returns best-effort facts for a directory with no package.json', async () => {
    const f = await extractProject('auction', 'mystery', `${fixtures}/does-not-exist`)
    expect(f.stack).toEqual([])
    expect(f.scripts).toEqual([])
    expect(f.tier).toBe('unknown')
  })
})
