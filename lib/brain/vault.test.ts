import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVault, discoverRepos } from './vault'
import { extractProject } from './extract-project'
import { ok } from '@/lib/result'

async function makeRepos(root: string) {
  const api = join(root, 'basworld', 'auction', 'api')
  await mkdir(api, { recursive: true })
  await writeFile(join(api, 'package.json'), JSON.stringify({ dependencies: { '@nestjs/core': '1' }, scripts: { build: 'x' } }))
}

const deps = {
  extract: extractProject,
  fetchAdr: async () => ok({ id: '1', title: 'ADR-6 X', html: '<p>Body</p>', sourceUrl: 'https://x/wiki/1' }),
  htmlToMd: (h: string) => h.replace(/<[^>]+>/g, ''),
  syncedDate: '2026-07-02',
}

describe('discoverRepos', () => {
  it('flattens owner/group/app into group/app', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repos-'))
    await makeRepos(root)
    const repos = await discoverRepos(root)
    expect(repos).toEqual([{ group: 'auction', app: 'api', repoPath: join(root, 'basworld', 'auction', 'api') }])
    await rm(root, { recursive: true, force: true })
  })
})

describe('buildVault', () => {
  let brainDir: string
  let reposDir: string
  beforeEach(async () => {
    reposDir = await mkdtemp(join(tmpdir(), 'repos-'))
    brainDir = await mkdtemp(join(tmpdir(), 'brain-'))
    await makeRepos(reposDir)
  })

  it('creates standards, project pages, ADRs, and indexes', async () => {
    const summary = await buildVault({ brainDir, reposDir, adrPages: ['1'], check: false, scope: 'all' }, deps)
    expect(summary.added.some((p) => p.includes('standards/deployment.md'))).toBe(true)
    const project = await readFile(join(brainDir, 'projects', 'auction', 'api.md'), 'utf8')
    expect(project).toContain('NestJS')
    const adr = await readFile(join(brainDir, 'adrs', 'ADR-0006-adr-6-x.md'), 'utf8')
    expect(adr).toContain('Body')

    const read = (rel: string) => readFile(join(brainDir, rel), 'utf8')
    expect(await read('architecture/index.md')).toContain('# Architecture')
    expect(await read('architecture/domain-layer.md')).toContain('Bounded contexts')
    expect(await read('architecture/system-flow.md')).toContain('FE → BFF → API')
  })

  it('auto-fills testing.md with detected tooling and preserves hand edits on rebuild', async () => {
    await buildVault({ brainDir, reposDir, adrPages: [], check: false, scope: 'all' }, deps)
    const testingPath = join(brainDir, 'standards', 'testing.md')
    const testing = await readFile(testingPath, 'utf8')
    expect(testing).toContain('<!-- AUTO:start')

    const withMarker = `${await readFile(testingPath, 'utf8')}\nHAND-EDITED MARKER\n`
    await writeFile(testingPath, withMarker)

    await buildVault({ brainDir, reposDir, adrPages: [], check: false, scope: 'all' }, deps)
    const rebuilt = await readFile(testingPath, 'utf8')
    expect(rebuilt).toContain('<!-- AUTO:start')
    expect(rebuilt).toContain('HAND-EDITED MARKER')
  })

  it('preserves hand-authored prose and does not overwrite existing standards', async () => {
    await buildVault({ brainDir, reposDir, adrPages: [], check: false, scope: 'all' }, deps)
    const p = join(brainDir, 'projects', 'auction', 'api.md')
    const edited = (await readFile(p, 'utf8')).replace('_Describe what this project does._', 'Runs auctions.')
    await writeFile(p, edited)
    await writeFile(join(brainDir, 'standards', 'api.md'), '---\ntype: standard\n---\nMY API RULES\n')

    const summary = await buildVault({ brainDir, reposDir, adrPages: [], check: false, scope: 'all' }, deps)
    expect(await readFile(p, 'utf8')).toContain('Runs auctions.')
    expect(await readFile(join(brainDir, 'standards', 'api.md'), 'utf8')).toContain('MY API RULES')
    expect(summary.skipped.some((s) => s.includes('standards/api.md'))).toBe(true)
  })

  it('writes a placeholder and warns when an ADR fetch fails', async () => {
    const failing = { ...deps, fetchAdr: async () => ({ ok: false as const, reason: 'error' as const, message: 'boom' }) }
    const summary = await buildVault({ brainDir, reposDir, adrPages: ['999'], check: false, scope: 'all' }, failing)
    expect(summary.warned.length).toBeGreaterThan(0)
  })

  it('check mode reports counts but writes nothing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'brain-'))
    const summary = await buildVault({ brainDir: empty, reposDir, adrPages: [], check: true, scope: 'all' }, deps)
    expect(summary.added.length).toBeGreaterThan(0)
    await expect(readFile(join(empty, 'index.md'), 'utf8')).rejects.toThrow()
  })
})
