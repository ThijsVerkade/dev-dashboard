import 'server-only'
import { readdir, stat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { Result, ok, failure, unconfigured } from '@/lib/result'

export type LiveEventKind = 'text' | 'tool_use' | 'tool_result'
export type LiveEvent = {
  ts: string
  role: 'user' | 'assistant'
  kind: LiveEventKind
  label: string
}
export type ClaudeLive = {
  project: string
  sessionId: string
  model: string
  lastActivity: string
  status: string
  events: LiveEvent[]
}

export type ActiveSession = {
  sessionId: string
  project: string
  model: string
  status: string
  lastActivity: string
  lastEventLabel: string
}

const TEXT_MAX = 120
const ARG_MAX = 80
const EVENT_LIMIT = 40
const TAIL_BYTES = 256 * 1024
const IDLE_AFTER_MS = 60_000
const ACTIVE_WINDOW_MS = 10 * 60_000
const ACTIVE_CAP = 8
const STATUS_TAIL_BYTES = 16 * 1024

// --- pure helpers (unit-tested) ---------------------------------------------

/** Parse a tail chunk of newline-delimited JSON. Any line that does not parse
 *  (a truncated leading/trailing fragment, or a blank line) is skipped. */
export function parseTranscriptTail(chunk: string): any[] {
  const out: any[] = []
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // truncated fragment or malformed line — ignore
    }
  }
  return out
}

/** A short, human-friendly summary of a tool call's key argument. */
export function summarizeToolInput(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const pick = (v: unknown) => (typeof v === 'string' ? v : '')
  let raw = ''
  switch (name) {
    case 'Bash':
      raw = pick(i.command)
      break
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      raw = basename(pick(i.file_path))
      break
    case 'Grep':
    case 'Glob':
      raw = pick(i.pattern)
      break
    case 'Task':
    case 'Agent':
      raw = pick(i.description)
      break
    default:
      raw = ''
  }
  raw = raw.replace(/\s+/g, ' ').trim()
  return raw.length > ARG_MAX ? raw.slice(0, ARG_MAX) + '…' : raw
}

/** Turn raw transcript lines into a capped list of display events.
 *  `thinking` blocks are intentionally dropped. */
export function normalizeEvents(lines: any[], limit: number): LiveEvent[] {
  const events: LiveEvent[] = []
  for (const line of lines) {
    const role = line?.type
    if (role !== 'user' && role !== 'assistant') continue
    const ts: string = typeof line?.timestamp === 'string' ? line.timestamp : ''
    const content = line?.message?.content

    if (typeof content === 'string') {
      if (content.trim()) events.push({ ts, role, kind: 'text', label: clip(content, TEXT_MAX) })
      continue
    }
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      switch (block.type) {
        case 'thinking':
          break // hidden from the feed
        case 'text':
          if (typeof block.text === 'string' && block.text.trim())
            events.push({ ts, role, kind: 'text', label: clip(block.text, TEXT_MAX) })
          break
        case 'tool_use': {
          const name = typeof block.name === 'string' ? block.name : 'tool'
          const summary = summarizeToolInput(name, block.input)
          events.push({ ts, role, kind: 'tool_use', label: summary ? `${name} · ${summary}` : name })
          break
        }
        case 'tool_result':
          events.push({ ts, role, kind: 'tool_result', label: block.is_error ? 'error' : 'result' })
          break
      }
    }
  }
  return events.slice(-limit)
}

/** Derive a one-line status from the most recent event. */
export function deriveStatus(events: LiveEvent[], nowMs: number): string {
  const last = events[events.length - 1]
  if (!last) return 'idle'
  const ageMs = nowMs - Date.parse(last.ts)
  if (Number.isFinite(ageMs) && ageMs > IDLE_AFTER_MS) {
    return `idle ${Math.round(ageMs / 1000)}s`
  }
  if (last.kind === 'tool_use') return `running ${last.label.split(' ·')[0]}`
  if (last.kind === 'tool_result') return 'working'
  if (last.kind === 'text') return last.role === 'assistant' ? 'responding' : 'starting'
  return 'active'
}

/** Best-effort project name from an encoded ~/.claude/projects directory name. */
export function projectFromDir(dir: string): string {
  const m = dir.match(/workspace-(.+)$/)
  if (m) return m[1]
  return dir.replace(/^-+/, '')
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max) + '…' : one
}

export type SessionFile = { path: string; dir: string; mtimeMs: number }

/** Files touched within `windowMs`, newest first, capped at `cap`. */
export function selectActiveSessions(
  files: SessionFile[],
  nowMs: number,
  windowMs: number,
  cap: number,
): SessionFile[] {
  return files
    .filter((file) => nowMs - file.mtimeMs <= windowMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, cap)
}

/** Resolve a session id to a scanned file. Unknown/unsafe ids fall back to the
 *  newest — the id is only ever compared to known basenames, never joined into
 *  a path, so this is the path-traversal guard. */
export function findSessionById(files: SessionFile[], sessionId?: string): SessionFile | null {
  if (files.length === 0) return null
  if (!sessionId) return files[0]
  return files.find((file) => basename(file.path, '.jsonl') === sessionId) ?? files[0]
}

// --- I/O --------------------------------------------------------------------

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const SCAN_TTL_MS = 5_000
let scanCache: { value: SessionFile[]; expires: number } | null = null

/** All transcripts across all projects, newest-first. Cached briefly. */
async function scanSessions(): Promise<SessionFile[]> {
  const now = Date.now()
  if (scanCache && scanCache.expires > now) return scanCache.value

  const found: SessionFile[] = []
  const dirs = await readdir(PROJECTS_DIR, { withFileTypes: true })
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dirPath = join(PROJECTS_DIR, d.name)
    let files: string[]
    try {
      files = await readdir(dirPath)
    } catch {
      continue
    }
    for (const fileName of files) {
      if (!fileName.endsWith('.jsonl')) continue
      try {
        const s = await stat(join(dirPath, fileName))
        found.push({ path: join(dirPath, fileName), dir: d.name, mtimeMs: s.mtimeMs })
      } catch {
        // file vanished between readdir and stat — ignore
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  scanCache = { value: found, expires: now + SCAN_TTL_MS }
  return found
}

/** Read only the trailing bytes of a (potentially huge) file. */
async function readTail(path: string, maxBytes: number): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    const buf = Buffer.alloc(length)
    await fh.read(buf, 0, length, start)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

/** Overview of every recently-active session (for the sessions list). */
export async function getActiveSessions(): Promise<Result<ActiveSession[]>> {
  try {
    const files = await scanSessions()
    const active = selectActiveSessions(files, Date.now(), ACTIVE_WINDOW_MS, ACTIVE_CAP)
    const sessions = await Promise.all(
      active.map(async (file) => {
        const chunk = await readTail(file.path, STATUS_TAIL_BYTES)
        const lines = parseTranscriptTail(chunk)
        const events = normalizeEvents(lines, EVENT_LIMIT)
        const model =
          [...lines].reverse().find((l) => typeof l?.message?.model === 'string')?.message.model ?? ''
        const last = events[events.length - 1]
        return {
          sessionId: basename(file.path, '.jsonl'),
          project: projectFromDir(file.dir),
          model,
          status: deriveStatus(events, Date.now()),
          lastActivity: last?.ts ?? new Date(file.mtimeMs).toISOString(),
          lastEventLabel: last?.label ?? '',
        }
      }),
    )
    return ok(sessions)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return unconfigured('no Claude sessions found')
    return failure(e instanceof Error ? e.message : 'Failed to read Claude transcripts')
  }
}

export async function getLive(sessionId?: string): Promise<Result<ClaudeLive>> {
  try {
    const files = await scanSessions()
    const session = findSessionById(files, sessionId)
    if (!session) return unconfigured('no Claude sessions found')

    const chunk = await readTail(session.path, TAIL_BYTES)
    const lines = parseTranscriptTail(chunk)
    const events = normalizeEvents(lines, EVENT_LIMIT)

    const model =
      [...lines].reverse().find((l) => typeof l?.message?.model === 'string')?.message.model ?? ''
    const lastActivity = events[events.length - 1]?.ts ?? new Date(session.mtimeMs).toISOString()

    return ok({
      project: projectFromDir(session.dir),
      sessionId: basename(session.path, '.jsonl').slice(0, 8),
      model,
      lastActivity,
      status: deriveStatus(events, Date.now()),
      events,
    })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return unconfigured('no Claude sessions found')
    return failure(e instanceof Error ? e.message : 'Failed to read Claude transcript')
  }
}
