import 'server-only'
import { env } from '@/lib/env'
import { dashboardConfig } from '@/dashboard.config'
import { Result, ok, unconfigured, failure } from '@/lib/result'

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

export function buildJql(where: string, projects: string[]): string {
  const scope = projects.length ? ` AND project in (${projects.join(',')})` : ''
  return `${where}${scope} ORDER BY updated DESC`
}

async function search(jql: string): Promise<Result<Issue[]>> {
  const cfg = env.jira()
  if (!cfg) return unconfigured('Set JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN in .env.local')
  try {
    const res = await fetch(`${cfg.host}/rest/api/3/search/jql`, {
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
