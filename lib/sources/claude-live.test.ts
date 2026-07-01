import { expect, test } from 'vitest'
import {
  parseTranscriptTail,
  normalizeEvents,
  summarizeToolInput,
  deriveStatus,
  projectFromDir,
  selectActiveSessions,
  findSessionById,
  type SessionFile,
} from './claude-live'

test('parseTranscriptTail drops a truncated leading partial line and parses the rest', () => {
  // A tail read typically starts mid-line; that first fragment is not valid JSON.
  const chunk =
    '13Z","message":{"role":"user"}}\n' +
    '{"type":"assistant","timestamp":"2026-06-23T20:01:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}\n'
  const lines = parseTranscriptTail(chunk)
  expect(lines).toHaveLength(1)
  expect(lines[0].type).toBe('assistant')
})

test('parseTranscriptTail skips blank lines and a trailing partial line', () => {
  const chunk =
    '{"type":"user","timestamp":"2026-06-23T20:00:00.000Z","message":{"role":"user","content":"go"}}\n' +
    '\n' +
    '{"type":"assistant","timestamp":"2026-06-23T20:0' // truncated, no newline
  const lines = parseTranscriptTail(chunk)
  expect(lines).toHaveLength(1)
  expect(lines[0].type).toBe('user')
})

test('normalizeEvents skips thinking blocks and maps text + tool_use', () => {
  const lines = [
    {
      type: 'assistant',
      timestamp: '2026-06-23T20:01:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret reasoning' },
          { type: 'text', text: 'Let me check the files' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
        ],
      },
    },
  ]
  const events = normalizeEvents(lines, 40)
  expect(events).toEqual([
    { ts: '2026-06-23T20:01:00.000Z', role: 'assistant', kind: 'text', label: 'Let me check the files' },
    { ts: '2026-06-23T20:01:00.000Z', role: 'assistant', kind: 'tool_use', label: 'Bash · ls -la' },
  ])
})

test('normalizeEvents maps a string user message and a tool_result', () => {
  const lines = [
    { type: 'user', timestamp: '2026-06-23T20:00:00.000Z', message: { role: 'user', content: 'go ahead' } },
    {
      type: 'user',
      timestamp: '2026-06-23T20:00:01.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'a lot of output' }] },
    },
  ]
  const events = normalizeEvents(lines, 40)
  expect(events[0]).toEqual({ ts: '2026-06-23T20:00:00.000Z', role: 'user', kind: 'text', label: 'go ahead' })
  expect(events[1].kind).toBe('tool_result')
})

test('normalizeEvents keeps only the last `limit` events', () => {
  const lines = Array.from({ length: 10 }, (_, i) => ({
    type: 'assistant',
    timestamp: `2026-06-23T20:00:0${i}.000Z`,
    message: { role: 'assistant', content: [{ type: 'text', text: `m${i}` }] },
  }))
  const events = normalizeEvents(lines, 3)
  expect(events.map((e) => e.label)).toEqual(['m7', 'm8', 'm9'])
})

test('summarizeToolInput summarizes common tools by their key argument', () => {
  expect(summarizeToolInput('Bash', { command: 'npm test' })).toBe('npm test')
  expect(summarizeToolInput('Read', { file_path: '/a/b/page.tsx' })).toBe('page.tsx')
  expect(summarizeToolInput('Edit', { file_path: '/a/b/claude.ts' })).toBe('claude.ts')
  expect(summarizeToolInput('Grep', { pattern: 'TODO' })).toBe('TODO')
  expect(summarizeToolInput('UnknownTool', { whatever: 1 })).toBe('')
})

test('deriveStatus reports the running tool when last event is an unfinished tool_use', () => {
  const events = [{ ts: '2026-06-23T20:01:00.000Z', role: 'assistant' as const, kind: 'tool_use' as const, label: 'Bash · ls' }]
  const now = Date.parse('2026-06-23T20:01:02.000Z')
  expect(deriveStatus(events, now)).toBe('running Bash')
})

test('deriveStatus reports responding when last event is assistant text', () => {
  const events = [{ ts: '2026-06-23T20:01:00.000Z', role: 'assistant' as const, kind: 'text' as const, label: 'done' }]
  const now = Date.parse('2026-06-23T20:01:01.000Z')
  expect(deriveStatus(events, now)).toBe('responding')
})

test('deriveStatus reports idle with elapsed seconds when last activity is old', () => {
  const events = [{ ts: '2026-06-23T20:00:00.000Z', role: 'assistant' as const, kind: 'text' as const, label: 'done' }]
  const now = Date.parse('2026-06-23T20:02:30.000Z') // 150s later
  expect(deriveStatus(events, now)).toBe('idle 150s')
})

test('projectFromDir extracts the project name from an encoded ~/.claude/projects dir', () => {
  expect(projectFromDir('-Users-thijs-verkade-workspace-dev-dashboard')).toBe('dev-dashboard')
  expect(projectFromDir('-Users-thijs-verkade-other-thing')).toBe('Users-thijs-verkade-other-thing')
})

const f = (name: string, mtimeMs: number): SessionFile => ({
  path: `/p/dir/${name}.jsonl`,
  dir: 'dir',
  mtimeMs,
})

test('selectActiveSessions keeps only files within the window, newest-first', () => {
  const now = 1_000_000
  const files = [f('a', now - 5_000), f('b', now - 700_000), f('c', now - 1_000)]
  const active = selectActiveSessions(files, now, 600_000, 8)
  expect(active.map((s) => s.path)).toEqual(['/p/dir/c.jsonl', '/p/dir/a.jsonl'])
})

test('selectActiveSessions caps the list', () => {
  const now = 1_000_000
  const files = Array.from({ length: 12 }, (_, i) => f(`s${i}`, now - i))
  expect(selectActiveSessions(files, now, 600_000, 8)).toHaveLength(8)
})

test('findSessionById returns the newest when no id is given', () => {
  const files = [f('newest', 100), f('older', 50)]
  expect(findSessionById(files)?.path).toBe('/p/dir/newest.jsonl')
})

test('findSessionById matches by transcript basename', () => {
  const files = [f('newest', 100), f('wanted', 50)]
  expect(findSessionById(files, 'wanted')?.path).toBe('/p/dir/wanted.jsonl')
})

test('findSessionById falls back to newest for an unknown or unsafe id (no path built)', () => {
  const files = [f('newest', 100), f('older', 50)]
  expect(findSessionById(files, '../../etc/passwd')?.path).toBe('/p/dir/newest.jsonl')
})

test('findSessionById returns null when there are no files', () => {
  expect(findSessionById([], 'anything')).toBeNull()
})
