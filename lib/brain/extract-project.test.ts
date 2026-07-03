import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { extractProject } from './extract-project'

const fixtures = fileURLToPath(new URL('./__fixtures__', import.meta.url))

describe('extractProject', () => {
  it('extracts stack, scripts, readme, and tier from a nest api', async () => {
    const f = await extractProject('auction', 'api', `${fixtures}/nest-api`)
    expect(f.tier).toBe('api')
    expect(f.stack.some((s) => s.startsWith('NestJS'))).toBe(true)
    expect(f.stack.some((s) => s.startsWith('Drizzle'))).toBe(true)
    expect(f.stack.some((s) => s.startsWith('Postgres'))).toBe(true)
    expect(f.scripts).toEqual(expect.arrayContaining(['start:dev', 'build', 'test']))
    expect(f.readmeTitle).toBe('Auction API')
    expect(f.readmeIntro).toBe('The auction service. Handles listings, bids, and settlement.')
    expect(f.hasAgentsDoc).toBe(false)
  })

  it('detects Next.js frontend and tolerates a missing README', async () => {
    const f = await extractProject('auction', 'fe', `${fixtures}/next-fe`)
    expect(f.tier).toBe('frontend')
    expect(f.stack.some((s) => s.startsWith('Next.js'))).toBe(true)
    expect(f.stack.some((s) => s.startsWith('React'))).toBe(true)
    expect(f.readmeTitle).toBeUndefined()
  })

  it('returns best-effort facts for a directory with no package.json', async () => {
    const f = await extractProject('auction', 'mystery', `${fixtures}/does-not-exist`)
    expect(f.stack).toEqual([])
    expect(f.scripts).toEqual([])
    expect(f.tier).toBe('unknown')
    expect(f.envKeys).toEqual([])
    expect(f.layout).toEqual([])
    expect(f.boundedContexts).toEqual([])
  })

  it('extracts composer stack with versions and composer scripts', async () => {
    const f = await extractProject('auction', 'api', `${fixtures}/laravel-api`)
    expect(f.tier).toBe('api')
    expect(f.stack).toEqual(
      expect.arrayContaining(['PHP ^8.2', 'Laravel ^13.0', 'Pest', 'Larastan', 'Pint', 'Symfony']),
    )
    expect(f.scripts).toEqual(expect.arrayContaining(['code-style', 'unit-test']))
  })

  it('versions npm stack labels from package.json', async () => {
    const f = await extractProject('auction', 'fe', `${fixtures}/next-fe`)
    // next-fe fixture pins next + react; labels should carry their versions
    expect(f.stack.some((s) => s.startsWith('Next.js '))).toBe(true)
  })

  it('parses env keys only (never values) from .env.example', async () => {
    const f = await extractProject('auction', 'api', `${fixtures}/laravel-api`)
    expect(f.envKeys).toEqual(
      expect.arrayContaining(['APP_NAME', 'APP_KEY', 'AUCTION_API_URL', 'DB_PASSWORD']),
    )
    expect(JSON.stringify(f)).not.toContain('secret-should-never-be-emitted')
    expect(JSON.stringify(f)).not.toContain('localhost:8000')
  })

  it('detects bounded contexts (app/*/Domain) for api tier', async () => {
    const f = await extractProject('auction', 'api', `${fixtures}/laravel-api`)
    expect(f.boundedContexts).toEqual(['Auction', 'Shared'])
  })

  it('does not detect bounded contexts for a frontend', async () => {
    const f = await extractProject('auction', 'fe', `${fixtures}/next-fe`)
    expect(f.boundedContexts).toEqual([])
  })

  it('lists top-level layout dirs, excluding noise', async () => {
    const f = await extractProject('auction', 'api', `${fixtures}/laravel-api`)
    expect(f.layout).toContain('app')
  })

  it('captures the first README section, not just one line', async () => {
    const f = await extractProject('auction', 'api', `${fixtures}/laravel-api`)
    expect(f.readmeIntro).toContain('documents nothing real')
    expect(f.readmeIntro).not.toContain('Should not appear')
  })
})
