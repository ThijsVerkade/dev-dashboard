import { expect, test } from 'vitest'
import { parseDaily, parseSessions } from './claude'

test('parseDaily reads totals and per-day rows defensively (real ccusage@20 uses period for date)', () => {
  // Real ccusage@20 daily items use "period" for the date string, not "date"
  const json = {
    daily: [{ period: '2026-06-23', totalTokens: 1500, totalCost: 0.42 }],
    totals: { totalTokens: 1500, totalCost: 0.42 },
  }
  expect(parseDaily(json)).toEqual({
    totalCost: 0.42,
    totalTokens: 1500,
    days: [{ date: '2026-06-23', cost: 0.42, tokens: 1500 }],
  })
})

test('parseDaily also accepts legacy "date" field for forward compat', () => {
  const json = {
    daily: [{ date: '2026-06-23', totalTokens: 1500, totalCost: 0.42 }],
    totals: { totalTokens: 1500, totalCost: 0.42 },
  }
  expect(parseDaily(json)).toEqual({
    totalCost: 0.42,
    totalTokens: 1500,
    days: [{ date: '2026-06-23', cost: 0.42, tokens: 1500 }],
  })
})

test('parseDaily tolerates missing fields', () => {
  expect(parseDaily({})).toEqual({ totalCost: 0, totalTokens: 0, days: [] })
})

test('parseSessions maps session rows (real ccusage@20 shape: key=session, period as id, agent as project, metadata.lastActivity)', () => {
  const json = {
    session: [
      {
        period: 'abc-uuid-1',
        agent: 'claude',
        totalTokens: 900,
        totalCost: 0.1,
        metadata: { lastActivity: '2026-06-23T10:00:00.000Z' },
      },
    ],
  }
  expect(parseSessions(json)).toEqual([
    { sessionId: 'abc-uuid-1', project: 'claude', cost: 0.1, tokens: 900, lastActivity: '2026-06-23T10:00:00.000Z' },
  ])
})

test('parseSessions tolerates legacy "sessions" key for forward compat', () => {
  const json = {
    sessions: [
      { sessionId: 's1', project: 'dev-dashboard', totalTokens: 900, totalCost: 0.1, lastActivity: '2026-06-23' },
    ],
  }
  expect(parseSessions(json)).toEqual([
    { sessionId: 's1', project: 'dev-dashboard', cost: 0.1, tokens: 900, lastActivity: '2026-06-23' },
  ])
})
