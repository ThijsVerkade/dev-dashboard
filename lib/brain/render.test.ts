import { describe, it, expect } from 'vitest'
import { renderProjectPage, renderAdr, renderStandardStub, renderIndex, slugify } from './render'
import { AUTO_START } from './auto-block'
import type { ProjectFacts } from './types'

const facts: ProjectFacts = {
  group: 'auction', app: 'api', tier: 'api', repoPath: 'repos/basworld/auction/api',
  stack: ['NestJS', 'Drizzle'], scripts: ['start:dev', 'build'], readmeTitle: 'Auction API',
  readmeIntro: 'The auction service.', hasAgentsDoc: false,
}

describe('renderProjectPage', () => {
  it('includes frontmatter, auto block, tier links, and stub prose', () => {
    const { content } = renderProjectPage(facts, null, '2026-07-02')
    expect(content).toMatch(/^---\ntype: project\n/)
    expect(content).toContain('tier: api')
    expect(content).toContain(AUTO_START)
    expect(content).toContain('NestJS')
    expect(content).toContain('[[api]]')
    expect(content).toContain('[[deployment]]')
    expect(content).toContain('## What this does')
  })

  it('preserves hand-authored prose on re-render', () => {
    const first = renderProjectPage(facts, null, '2026-07-02').content
    const edited = first.replace('_Describe what this project does._', 'It runs auctions.')
    const { content } = renderProjectPage(facts, edited, '2026-07-03')
    expect(content).toContain('It runs auctions.')
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

describe('renderIndex + slugify', () => {
  it('renders a link list', () => {
    expect(renderIndex('Projects', [{ label: 'API', href: 'auction/api' }])).toContain('- [[auction/api|API]]')
  })
  it('slugifies', () => expect(slugify('ADR-6 Merge commits')).toBe('adr-6-merge-commits'))
})
