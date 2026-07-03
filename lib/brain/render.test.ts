import { describe, it, expect } from 'vitest'
import {
  renderProjectPage,
  renderAdr,
  renderStandardStub,
  renderStandardWithTooling,
  renderToolingBlock,
  renderIndex,
  slugify,
} from './render'
import { AUTO_START } from './auto-block'
import type { ProjectFacts } from './types'

const facts: ProjectFacts = {
  group: 'auction', app: 'api', tier: 'api', repoPath: 'repos/basworld/auction/api',
  stack: ['NestJS', 'Drizzle'], scripts: ['start:dev', 'build'], readmeTitle: 'Auction API',
  readmeIntro: 'The auction service.', hasAgentsDoc: false,
  envKeys: ['APP_NAME', 'AUCTION_API_URL'],
  layout: ['app', 'routes', 'tests'],
  boundedContexts: ['Auction', 'Shared'],
}

describe('renderProjectPage', () => {
  it('includes frontmatter, auto block, tier links, and stub prose', () => {
    const { content } = renderProjectPage(facts, null, '2026-07-02')
    expect(content).toMatch(/^---\ntype: project\n/)
    expect(content).toContain('tier: api')
    expect(content).toContain(AUTO_START)
    expect(content).toContain('NestJS')
    expect(content).toContain('[[standards/api|api]]')
    expect(content).toContain('[[standards/deployment|deployment]]')
    expect(content).toContain('## What this does')
  })

  it('preserves hand-authored prose on re-render', () => {
    const first = renderProjectPage(facts, null, '2026-07-02').content
    const edited = first.replace('_Describe what this project does._', 'It runs auctions.')
    const { content } = renderProjectPage(facts, edited, '2026-07-03')
    expect(content).toContain('It runs auctions.')
  })

  it('does not duplicate the title across repeated re-renders', () => {
    let out = renderProjectPage(facts, null, '2026-07-02').content
    out = renderProjectPage(facts, out, '2026-07-03').content
    out = renderProjectPage(facts, out, '2026-07-04').content
    expect(out.match(/# auction\/api/g)?.length).toBe(1)
  })

  it('renders configuration, layout, and bounded-contexts sections', () => {
    const { content } = renderProjectPage(facts, null, '2026-07-02')
    expect(content).toContain('## Configuration')
    expect(content).toContain('`AUCTION_API_URL`')
    expect(content).toContain('## Layout')
    expect(content).toContain('## Bounded contexts')
    expect(content).toContain('Auction')
  })

  it('omits bounded contexts for a non-api page', () => {
    const feFacts = { ...facts, tier: 'frontend' as const, boundedContexts: [] }
    const { content } = renderProjectPage(feFacts, null, '2026-07-02')
    expect(content).not.toContain('## Bounded contexts')
  })
})

describe('renderAdr', () => {
  it('numbers, slugs, and stamps source', () => {
    const adr = renderAdr({ id: '234567', title: 'ADR-6 Merge commits', markdown: '# ADR-6\nUse BAS standard.', sourceUrl: 'https://x/wiki/y' }, '2026-07-02')
    expect(adr.number).toBe(6)
    expect(adr.slug).toBe('ADR-0006-adr-6-merge-commits')
    expect(adr.markdown).toContain('source-url: https://x/wiki/y')
    expect(adr.markdown).toContain('Use BAS standard.')
  })
})

describe('renderStandardStub', () => {
  it('pre-fills deployment with real facts', () => {
    const md = renderStandardStub('deployment')
    expect(md).toContain('deploy:staging')
    expect(md).toContain('App Runner')
    expect(md).toContain('dev / stg / prod')
  })
  it('stubs other standards', () => {
    expect(renderStandardStub('api')).toContain('type: standard')
  })
})

describe('renderToolingBlock', () => {
  const toolFacts = [
    { tier: 'api', stack: ['PHP ^8.2', 'Pest', 'Pint'], scripts: ['unit-test', 'code-style'] },
    { tier: 'frontend', stack: ['Next.js ^16'], scripts: ['test', 'lint', 'format'] },
  ] as unknown as ProjectFacts[]

  it('summarizes test frameworks grouped by tier', () => {
    const md = renderToolingBlock('testing', toolFacts)
    expect(md).toContain('Pest')
    expect(md).toMatch(/api/)
  })

  it('summarizes linters and formatters', () => {
    const md = renderToolingBlock('coding-standards', toolFacts)
    expect(md).toContain('Pint')
    expect(md).toContain('ESLint')
    expect(md).toContain('Prettier')
  })
})

describe('renderStandardWithTooling', () => {
  const toolFacts = [
    { tier: 'api', stack: ['PHP ^8.2', 'Pest', 'Pint'], scripts: ['unit-test', 'code-style'] },
  ] as unknown as ProjectFacts[]

  it('reuses the same frontmatter and title as renderStandardStub', () => {
    const withTooling = renderStandardWithTooling('testing', toolFacts, null)
    expect(withTooling).toMatch(/^---\ntype: standard\ntier: testing\nstatus: authored\n---\n\n# Testing\n/)
  })

  it('includes an AUTO block with detected tooling and the stub prose', () => {
    const content = renderStandardWithTooling('testing', toolFacts, null)
    expect(content).toContain(AUTO_START)
    expect(content).toContain('Pest')
    expect(content).toContain('## Expectations per tier')
  })

  it('preserves hand-authored prose below the AUTO block on re-render', () => {
    const first = renderStandardWithTooling('testing', toolFacts, null)
    const edited = first.replace('_TBD._', 'Run Pest for api, Vitest for frontend.')
    const second = renderStandardWithTooling('testing', toolFacts, edited)
    expect(second).toContain('Run Pest for api, Vitest for frontend.')
    expect(second).toContain(AUTO_START)
  })
})

describe('renderIndex + slugify', () => {
  it('renders a link list', () => {
    expect(renderIndex('Projects', [{ label: 'API', href: 'auction/api' }])).toContain('- [[auction/api|API]]')
  })
  it('slugifies', () => expect(slugify('ADR-6 Merge commits')).toBe('adr-6-merge-commits'))
})
