import { expect, test } from 'vitest'
import { reposForProject, resolveAgentRepo } from '@/dashboard.config'

const MAP = {
  'NBDE/api': 'lease/api@main',
  'NBDE/fe-bff': 'lease/fe-bff@main',
  'NBDE/fe-erp': 'lease/fe-erp@main',
  ERP: 'erp-bff-erp',
}

test('reposForProject lists the apps configured under a project, sorted', () => {
  expect(reposForProject('NBDE', MAP)).toEqual(['api', 'fe-bff', 'fe-erp'])
  expect(reposForProject('ERP', MAP)).toEqual([]) // flat entry has no apps
  expect(reposForProject('NONE', MAP)).toEqual([])
})

test('resolveAgentRepo prefers PROJECT/app, falls back to the flat project default', () => {
  expect(resolveAgentRepo('NBDE', 'fe-bff', MAP)).toBe('lease/fe-bff@main')
  expect(resolveAgentRepo('ERP', undefined, MAP)).toBe('erp-bff-erp')
  // unknown app for a multi-app project: no flat default, so undefined (don't mask the error)
  expect(resolveAgentRepo('NBDE', 'nope', MAP)).toBeUndefined()
  // flat project ignores the app and returns its single repo
  expect(resolveAgentRepo('ERP', 'whatever', MAP)).toBe('erp-bff-erp')
  expect(resolveAgentRepo('MISSING', 'api', MAP)).toBeUndefined()
})

test('resolveAgentRepo with no app on a multi-app project picks the first configured app', () => {
  // e.g. the acceptance flow dispatches without choosing an app
  expect(resolveAgentRepo('NBDE', undefined, MAP)).toBe('lease/api@main')
})
