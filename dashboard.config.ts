// Non-secret config: which resources the dashboard surfaces.
// Project ids/paths come from GITLAB_PROJECTS (comma-separated) if set,
// otherwise edit the defaults below.
const parseEnvList = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)

// Parse "KEY:value,KEY2:value2" into a record. Also accepts shorthand entries with
// no ":value" — e.g. "auction/api@main" — where the key is the path before any "@"
// and the value is the whole entry (path@branch). Used for agent repo mapping.
const parseEnvMap = (raw: string | undefined): Record<string, string> =>
  Object.fromEntries(
    parseEnvList(raw)
      .map((entry): [string, string] | null => {
        const colon = entry.indexOf(':')
        if (colon === -1) {
          const key = entry.split('@')[0].trim() // "auction/api@main" -> "auction/api"
          return key ? [key, entry] : null
        }
        const key = entry.slice(0, colon).trim()
        const value = entry.slice(colon + 1).trim()
        return key && value ? [key, value] : null
      })
      .filter((e): e is [string, string] => !!e),
  )

/** Group name of an AGENT_REPOS key, e.g. groupOf('auction/api') -> 'auction'. */
function groupOf(key: string): string {
  const i = key.indexOf('/')
  return i === -1 ? key : key.slice(0, i)
}

/** Ordered group names. `order` (AGENT_GROUPS) wins; else first-seen order in the map. */
export function agentGroups(
  map: Record<string, string> = dashboardConfig.agentRepos,
  order: string[] = dashboardConfig.agentGroupsOrder,
): string[] {
  const present = new Set(Object.keys(map).map(groupOf))
  if (order.length) return order.filter((g) => present.has(g))
  const seen: string[] = []
  for (const key of Object.keys(map)) {
    const g = groupOf(key)
    if (!seen.includes(g)) seen.push(g)
  }
  return seen
}

/** App names configured for a group, e.g. reposForGroup('auction') -> ['api','fe']. */
export function reposForGroup(
  group: string,
  map: Record<string, string> = dashboardConfig.agentRepos,
): string[] {
  const prefix = `${group}/`
  return Object.keys(map)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .sort()
}

/** Resolve the repo spec for a group+app, or undefined if unmapped. */
export function resolveGroupRepo(
  group: string,
  app: string,
  map: Record<string, string> = dashboardConfig.agentRepos,
): string | undefined {
  return map[`${group}/${app}`]
}

export const dashboardConfig = {
  gitlabProjects: parseEnvList(process.env.GITLAB_PROJECTS),
  gitlabGroups: parseEnvList(process.env.GITLAB_GROUPS),
  gitlabExcludes: parseEnvList(process.env.GITLAB_EXCLUDE),
  // Map "<gitlab project path>:<environment name>" -> CloudWatch log group.
  // e.g. { 'mygroup/svc:staging': '/aws/ecs/svc-stg' }. Missing key => env not clickable.
  cloudwatchLogGroups: {} as Record<string, string>,
  jiraProjects: parseEnvList(process.env.JIRA_PROJECTS),
  // Name of the manual GitLab job that deploys staging (played from the board).
  stagingJobName: process.env.GITLAB_STAGING_JOB ?? 'deploy:staging',
  // Map Jira project key -> local repo directory name, e.g.
  // AGENT_REPOS="NBDE:auction-api,ERP:erp-bff-erp". Resolved under workspaceDir.
  agentRepos: parseEnvMap(process.env.AGENT_REPOS),
  // Optional explicit group order/allowlist, e.g. AGENT_GROUPS="auction,lease".
  agentGroupsOrder: parseEnvList(process.env.AGENT_GROUPS),
  // Base directory holding local repos. Defaults to ~/workspace (resolved server-side).
  workspaceDir: process.env.WORKSPACE_DIR ?? '',
  // Map Jira project key -> staging base URL, e.g.
  // STAGING_URLS="NBDE:https://staging.example.com,ERP:https://erp-stg.example.com".
  // Missing key => the acceptance profile is not runnable for that project.
  stagingUrls: parseEnvMap(process.env.STAGING_URLS),
  // Optional Jira custom field id holding acceptance criteria; empty => read from description.
  acceptanceCriteriaField: process.env.ACCEPTANCE_CRITERIA_FIELD ?? '',
}
