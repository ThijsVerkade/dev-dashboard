import { expect, test } from 'vitest'
import { mapIssue, buildJql } from './jira'

const fullRaw = {
  key: 'AUC-123',
  fields: {
    summary: 'Fix login bug',
    status: {
      name: 'In Progress',
      statusCategory: { key: 'indeterminate' },
    },
    assignee: { displayName: 'Jane Doe' },
    priority: { name: 'High' },
    updated: '2026-06-23T09:00:00.000Z',
  },
}

test('mapIssue maps a full sample raw issue to Issue with correct url', () => {
  const issue = mapIssue(fullRaw, 'https://jira.example.com')
  expect(issue).toEqual({
    key: 'AUC-123',
    summary: 'Fix login bug',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    assignee: 'Jane Doe',
    priority: 'High',
    updated: '2026-06-23T09:00:00.000Z',
    url: 'https://jira.example.com/browse/AUC-123',
  })
})

test('mapIssue defaults missing assignee to Unassigned', () => {
  const raw = { key: 'AUC-1', fields: { assignee: null } }
  const issue = mapIssue(raw, 'https://jira.example.com')
  expect(issue.assignee).toBe('Unassigned')
})

test('mapIssue defaults missing fields to empty strings', () => {
  const raw = { key: 'AUC-2', fields: {} }
  const issue = mapIssue(raw, 'https://jira.example.com')
  expect(issue.summary).toBe('')
  expect(issue.status).toBe('')
  expect(issue.statusCategory).toBe('')
  expect(issue.priority).toBe('')
  expect(issue.updated).toBe('')
})

test('buildJql with no projects produces correct JQL without project scope', () => {
  const jql = buildJql('assignee = currentUser()', [])
  expect(jql).toBe('assignee = currentUser() ORDER BY updated DESC')
})

test('buildJql with projects includes AND project in clause before ORDER BY', () => {
  const jql = buildJql('sprint in openSprints()', ['AUC', 'LEASE'])
  expect(jql).toContain('AND project in (AUC,LEASE)')
  const andIndex = jql.indexOf('AND project in (AUC,LEASE)')
  const orderIndex = jql.indexOf(' ORDER BY')
  expect(andIndex).toBeLessThan(orderIndex)
})
