import { expect, test } from 'vitest'
import {
  extractCriteriaFromDescription, checkReadiness, parseVerdict, isCleanStartup,
  buildAcceptancePrompt, buildMissingInfoComment, buildResultComment,
  type AcceptanceDetail,
} from './acceptance-logic'

const base: AcceptanceDetail = {
  key: 'NBDE-817', summary: 'Telephone bids', description: '', url: 'https://x/browse/NBDE-817',
  status: 'Acceptance', assignee: { displayName: 'Ann', accountId: 'acc-1' },
  acceptanceCriteria: 'Given a lot, when I place a phone bid, it is recorded.',
}

test('extractCriteriaFromDescription pulls the Acceptance Criteria section', () => {
  const desc = 'Intro line\n\nAcceptance Criteria\n- bid recorded\n- email sent\n\nNotes\nignore me'
  expect(extractCriteriaFromDescription(desc)).toBe('- bid recorded\n- email sent')
})

test('extractCriteriaFromDescription returns null when absent', () => {
  expect(extractCriteriaFromDescription('just a description')).toBeNull()
  expect(extractCriteriaFromDescription('')).toBeNull()
})

test('checkReadiness returns empty when ready', () => {
  expect(checkReadiness(base)).toEqual([])
})

test('checkReadiness flags wrong status and missing criteria', () => {
  const missing = checkReadiness({ ...base, status: 'In Progress', acceptanceCriteria: null })
  expect(missing.some((m) => /Acceptance stage/i.test(m))).toBe(true)
  expect(missing.some((m) => /acceptance criteria/i.test(m))).toBe(true)
})

test('parseVerdict reads the last PASS/FAIL marker and trailing findings', () => {
  expect(parseVerdict('blah\nACCEPTANCE-RESULT: PASS all good').result).toBe('pass')
  expect(parseVerdict('ACCEPTANCE-RESULT: PASS\nACCEPTANCE-RESULT: FAIL step 3 broke').result).toBe('fail')
  expect(parseVerdict('no marker here')).toEqual({ result: 'unknown', findings: '' })
  expect(parseVerdict('ACCEPTANCE-RESULT: FAIL login button missing').findings).toContain('login button missing')
})

test('isCleanStartup is false on error markers or no events, true otherwise', () => {
  expect(isCleanStartup([{ message: 'Server listening on 3000' }])).toBe(true)
  expect(isCleanStartup([{ message: 'Unhandled Exception: boom' }])).toBe(false)
  expect(isCleanStartup([])).toBe(false)
})

test('buildAcceptancePrompt embeds url, criteria and the verdict marker instruction', () => {
  const p = buildAcceptancePrompt(base, { stagingUrl: 'https://staging.x' })
  expect(p).toContain('https://staging.x')
  expect(p).toContain('phone bid')
  expect(p).toContain('ACCEPTANCE-RESULT:')
  expect(p).toContain('chrome-devtools')
  expect(p.toLowerCase()).toContain("repository's own")
})

test('buildMissingInfoComment mentions the assignee and lists missing items', () => {
  const doc = buildMissingInfoComment(base, ['no acceptance criteria found'])
  const json = JSON.stringify(doc)
  expect(doc.type).toBe('doc')
  expect(json).toContain('acc-1')           // mention accountId
  expect(json).toContain('no acceptance criteria found')
})

test('buildResultComment reflects pass/fail', () => {
  expect(JSON.stringify(buildResultComment({ result: 'pass', findings: '' }))).toMatch(/PASS|passed/i)
  expect(JSON.stringify(buildResultComment({ result: 'fail', findings: 'x' }))).toMatch(/FAIL|failed/i)
})
