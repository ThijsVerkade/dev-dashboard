import { expect, test } from 'vitest'
import { mapAcceptanceDetail } from './jira'

const host = 'https://bas.atlassian.net'

test('mapAcceptanceDetail extracts status, assignee, and criteria from description', () => {
  const json = {
    key: 'NBDE-817',
    fields: {
      summary: 'Telephone bids',
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Acceptance Criteria' }] }, { type: 'paragraph', content: [{ type: 'text', text: '- bid recorded' }] }] },
      status: { name: 'Acceptance' },
      assignee: { displayName: 'Ann', accountId: 'acc-1' },
    },
  }
  const d = mapAcceptanceDetail(json, host, '')
  expect(d.key).toBe('NBDE-817')
  expect(d.status).toBe('Acceptance')
  expect(d.assignee).toEqual({ displayName: 'Ann', accountId: 'acc-1' })
  expect(d.acceptanceCriteria).toContain('bid recorded')
  expect(d.url).toBe('https://bas.atlassian.net/browse/NBDE-817')
})

test('mapAcceptanceDetail prefers a custom field for criteria when configured', () => {
  const json = {
    key: 'NBDE-1',
    fields: { summary: 's', description: null, status: { name: 'Acceptatie' }, assignee: null, customfield_123: 'field criteria' },
  }
  const d = mapAcceptanceDetail(json, host, 'customfield_123')
  expect(d.assignee).toBeNull()
  expect(d.acceptanceCriteria).toBe('field criteria')
})
