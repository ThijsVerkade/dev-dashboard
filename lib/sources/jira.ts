import 'server-only'
import { env } from '@/lib/env'
import { dashboardConfig } from '@/dashboard.config'
import { Result, ok, unconfigured, failure } from '@/lib/result'
import { createTtlCache } from '@/lib/ttl-cache'
import { fetchWithRetry } from '@/lib/fetch-retry'
import type { IssueDetail } from '@/lib/agent/prompt'
import { extractCriteriaFromDescription, type AcceptanceDetail, type AdfDoc } from '@/lib/agent/acceptance-logic'

/**
 * Cache issue searches for 30s, keyed by JQL. The panel polls three queries every
 * 60s and re-fetches on every navigation; without this each poll is a live Jira
 * round-trip (~0.4–2s). Only successful results are cached, and the write paths
 * below clear it so reassignments show up immediately. 30s < the 60s poll, so it
 * never adds staleness beyond what polling already implies.
 */
const searchCache = createTtlCache<Result<Issue[]>>(30_000, { shouldCache: (r) => r.ok })

export type Issue = {
  key: string
  summary: string
  status: string
  statusCategory: string
  assignee: string
  priority: string
  updated: string
  url: string
}

export function mapIssue(raw: any, host: string): Issue {
  const f = raw.fields ?? {}
  return {
    key: raw.key,
    summary: f.summary ?? '',
    status: f.status?.name ?? '',
    statusCategory: f.status?.statusCategory?.key ?? '',
    assignee: f.assignee?.displayName ?? 'Unassigned',
    priority: f.priority?.name ?? '',
    updated: f.updated ?? '',
    url: `${host}/browse/${raw.key}`,
  }
}

/** Jira label prefix that records which application/repo a ticket targets. */
export const APP_LABEL_PREFIX = 'app:'

/** Extract the target apps from a ticket's labels, e.g. ['app:fe','app:bff','x'] -> ['fe','bff']. */
export function parseAppLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return []
  return labels
    .filter((l): l is string => typeof l === 'string' && l.startsWith(APP_LABEL_PREFIX))
    .map((l) => l.slice(APP_LABEL_PREFIX.length))
    .filter(Boolean)
}

export function buildJql(where: string, projects: string[]): string {
  const scope = projects.length ? ` AND project in (${projects.join(',')})` : ''
  return `${where}${scope} ORDER BY updated DESC`
}

function search(jql: string): Promise<Result<Issue[]>> {
  return searchCache.get(jql, () => searchLive(jql))
}

async function searchLive(jql: string): Promise<Result<Issue[]>> {
  const cfg = env.jira()
  if (!cfg) return unconfigured('Set JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN in .env.local')
  try {
    const res = await fetchWithRetry(`${cfg.host}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64'),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jql,
        maxResults: 50,
        fields: ['summary', 'status', 'assignee', 'priority', 'updated'],
      }),
    })
    if (!res.ok) return failure(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = await res.json()
    return ok((json.issues ?? []).map((i: any) => mapIssue(i, cfg.host)))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'Jira request failed')
  }
}

export async function getMyIssues(): Promise<Result<Issue[]>> {
  return search(buildJql('assignee = currentUser() AND statusCategory != Done', []))
}

export async function getActiveSprint(): Promise<Result<Issue[]>> {
  return search(buildJql('sprint in openSprints()', dashboardConfig.jiraProjects))
}

export async function getRecent(): Promise<Result<Issue[]>> {
  return search(buildJql('updated >= -7d', dashboardConfig.jiraProjects))
}

export type JiraUser = { accountId: string; displayName: string }

function basicAuth(cfg: { email: string; token: string }): string {
  return 'Basic ' + Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')
}

/** Users assignable to a given issue (sprint team scope, capped at 50). */
export async function getAssignableUsers(issueKey: string): Promise<Result<JiraUser[]>> {
  const cfg = env.jira()
  if (!cfg) return unconfigured('Set JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN in .env.local')
  try {
    const url = `${cfg.host}/rest/api/3/user/assignable/search?issueKey=${encodeURIComponent(issueKey)}&maxResults=50`
    const res = await fetchWithRetry(url, {
      headers: { Authorization: basicAuth(cfg), Accept: 'application/json' },
    })
    if (!res.ok) return failure(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = await res.json()
    return ok(
      (Array.isArray(json) ? json : [])
        .filter((u: any) => u.accountId)
        .map((u: any) => ({ accountId: u.accountId, displayName: u.displayName ?? u.accountId })),
    )
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'Jira request failed')
  }
}

/** Reassign an issue. Pass accountId null to unassign. */
export async function assignIssue(issueKey: string, accountId: string | null): Promise<Result<{ key: string }>> {
  const cfg = env.jira()
  if (!cfg) return unconfigured('Set JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN in .env.local')
  try {
    const res = await fetchWithRetry(`${cfg.host}/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`, {
      method: 'PUT',
      headers: {
        Authorization: basicAuth(cfg),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accountId }),
    })
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200)
      const hint = res.status === 403 ? ' (token lacks Jira write permission)' : ''
      return failure(`Jira ${res.status}${hint}: ${detail}`)
    }
    // The assignee change must be reflected in the next my/sprint/recent poll.
    searchCache.clear()
    return ok({ key: issueKey })
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'Jira request failed')
  }
}

const BLOCK_ADF = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem'])

function walkAdf(node: any): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : ''
  if (node.type === 'hardBreak') return '\n'
  const kids = Array.isArray(node.content) ? node.content.map(walkAdf).join('') : ''
  return BLOCK_ADF.has(node.type) ? kids + '\n' : kids
}

/** Flatten an Atlassian Document Format node (or plain string) to text. */
export function flattenAdf(node: unknown): string {
  if (typeof node === 'string') return node
  return walkAdf(node).replace(/\n{3,}/g, '\n\n').trim()
}

/** Full detail for a single issue, including its (flattened) description. */
export async function getIssueDetail(key: string): Promise<Result<IssueDetail>> {
  const cfg = env.jira()
  if (!cfg) return unconfigured('Set JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN in .env.local')
  try {
    const url = `${cfg.host}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,labels`
    const res = await fetchWithRetry(url, {
      headers: { Authorization: basicAuth(cfg), Accept: 'application/json' },
    })
    if (!res.ok) return failure(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = await res.json()
    const f = json.fields ?? {}
    const issueKey = json.key ?? key
    return ok({
      key: issueKey,
      summary: f.summary ?? '',
      description: flattenAdf(f.description),
      url: `${cfg.host}/browse/${issueKey}`,
      apps: parseAppLabels(f.labels),
    })
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'Jira request failed')
  }
}

/**
 * Record the target apps on a ticket as `app:<name>` labels, preserving every
 * other label and replacing any existing `app:*`. Best-effort: needs a write token.
 */
export async function setIssueApps(issueKey: string, apps: string[]): Promise<Result<{ key: string }>> {
  const cfg = env.jira()
  if (!cfg) return unconfigured('Set JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN in .env.local')
  try {
    const getRes = await fetchWithRetry(
      `${cfg.host}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=labels`,
      { headers: { Authorization: basicAuth(cfg), Accept: 'application/json' } },
    )
    if (!getRes.ok) return failure(`Jira ${getRes.status}: ${(await getRes.text()).slice(0, 200)}`)
    const current: unknown = (await getRes.json())?.fields?.labels
    const kept = Array.isArray(current)
      ? current.filter((l): l is string => typeof l === 'string' && !l.startsWith(APP_LABEL_PREFIX))
      : []
    const labels = [...kept, ...apps.map((a) => `${APP_LABEL_PREFIX}${a}`)]
    const res = await fetchWithRetry(`${cfg.host}/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      method: 'PUT',
      headers: { Authorization: basicAuth(cfg), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { labels } }),
    })
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200)
      const hint = res.status === 403 ? ' (token lacks Jira write permission)' : ''
      return failure(`Jira ${res.status}${hint}: ${detail}`)
    }
    return ok({ key: issueKey })
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'Jira request failed')
  }
}

/** Pure mapping of a Jira issue payload into the acceptance-testing shape. */
export function mapAcceptanceDetail(json: any, host: string, criteriaField: string): AcceptanceDetail {
  const f = json.fields ?? {}
  const key = json.key
  const description = flattenAdf(f.description)
  const fromField = criteriaField ? (typeof f[criteriaField] === 'string' ? f[criteriaField].trim() : flattenAdf(f[criteriaField])) : ''
  const acceptanceCriteria = (fromField && fromField.trim()) || extractCriteriaFromDescription(description)
  return {
    key,
    summary: f.summary ?? '',
    description,
    url: `${host}/browse/${key}`,
    status: f.status?.name ?? '',
    assignee: f.assignee?.accountId
      ? { displayName: f.assignee.displayName ?? '', accountId: f.assignee.accountId }
      : null,
    acceptanceCriteria: acceptanceCriteria || null,
  }
}

/** Fetch the fields the acceptance profile needs. */
export async function getAcceptanceDetail(key: string): Promise<Result<AcceptanceDetail>> {
  const cfg = env.jira()
  if (!cfg) return unconfigured('Set JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN in .env.local')
  const field = dashboardConfig.acceptanceCriteriaField
  const fields = ['summary', 'description', 'status', 'assignee', ...(field ? [field] : [])].join(',')
  try {
    const url = `${cfg.host}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`
    const res = await fetchWithRetry(url, { headers: { Authorization: basicAuth(cfg), Accept: 'application/json' } })
    if (!res.ok) return failure(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return ok(mapAcceptanceDetail(await res.json(), cfg.host, field))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'Jira request failed')
  }
}

/** Post an ADF comment to an issue. */
export async function addComment(issueKey: string, body: AdfDoc): Promise<Result<{ key: string }>> {
  const cfg = env.jira()
  if (!cfg) return unconfigured('Set JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN in .env.local')
  try {
    // Plain fetch, no retry: posting a comment is not idempotent — a retry after a
    // lost response could add the same comment twice.
    const res = await fetch(`${cfg.host}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      headers: { Authorization: basicAuth(cfg), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    })
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200)
      const hint = res.status === 403 ? ' (token lacks Jira write permission)' : ''
      return failure(`Jira ${res.status}${hint}: ${detail}`)
    }
    return ok({ key: issueKey })
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'Jira request failed')
  }
}
