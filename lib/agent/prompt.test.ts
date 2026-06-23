import { expect, test } from 'vitest'
import { projectKeyOf, slugify, buildAgentPrompt } from './prompt'

test('projectKeyOf takes the part before the first dash', () => {
  expect(projectKeyOf('NBDE-817')).toBe('NBDE')
  expect(projectKeyOf('ERP-1234')).toBe('ERP')
  expect(projectKeyOf('SOLO')).toBe('SOLO')
})

test('slugify produces a kebab-case slug capped in length', () => {
  expect(slugify('Add telephone bids to auction!')).toBe('add-telephone-bids-to-auction')
  expect(slugify('  Fix: the THING (again) ')).toBe('fix-the-thing-again')
  // capped to 40 chars, no trailing dash
  const long = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30))
  expect(long.length).toBeLessThanOrEqual(40)
  expect(long.endsWith('-')).toBe(false)
})

test('buildAgentPrompt embeds ticket, branch, base and the GitLab push-option line', () => {
  const prompt = buildAgentPrompt(
    { key: 'NBDE-817', summary: 'Telephone bids', description: 'Allow phone bids on lots.', url: 'https://x/browse/NBDE-817' },
    { branch: 'feat/NBDE-817-telephone-bids', baseBranch: 'main' },
  )
  expect(prompt).toContain('NBDE-817')
  expect(prompt).toContain('Telephone bids')
  expect(prompt).toContain('Allow phone bids on lots.')
  expect(prompt).toContain('feat/NBDE-817-telephone-bids')
  expect(prompt).toContain('merge_request.create')
  expect(prompt).toContain('merge_request.target=main')
  expect(prompt).toContain('bas-merge-commit-messages')
})

test('buildAgentPrompt forbids committing to the base branch', () => {
  const prompt = buildAgentPrompt(
    { key: 'NBDE-1', summary: 's', description: 'd', url: 'u' },
    { branch: 'feat/NBDE-1-s', baseBranch: 'main' },
  )
  expect(prompt.toLowerCase()).toContain('never commit')
})
