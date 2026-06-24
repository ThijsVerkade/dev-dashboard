// Non-secret config: which resources the dashboard surfaces.
// Project ids/paths come from GITLAB_PROJECTS (comma-separated) if set,
// otherwise edit the defaults below.
const parseEnvList = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)

// Parse "KEY:value,KEY2:value2" into a record. Used for agent repo mapping.
const parseEnvMap = (raw: string | undefined): Record<string, string> =>
  Object.fromEntries(
    parseEnvList(raw)
      .map((pair) => {
        const i = pair.indexOf(':')
        return i === -1 ? null : [pair.slice(0, i).trim(), pair.slice(i + 1).trim()]
      })
      .filter((e): e is [string, string] => !!e && !!e[0] && !!e[1]),
  )

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
  // Base directory holding local repos. Defaults to ~/workspace (resolved server-side).
  workspaceDir: process.env.WORKSPACE_DIR ?? '',
  // Map Jira project key -> staging base URL, e.g.
  // STAGING_URLS="NBDE:https://staging.example.com,ERP:https://erp-stg.example.com".
  // Missing key => the acceptance profile is not runnable for that project.
  stagingUrls: parseEnvMap(process.env.STAGING_URLS),
  // Optional Jira custom field id holding acceptance criteria; empty => read from description.
  acceptanceCriteriaField: process.env.ACCEPTANCE_CRITERIA_FIELD ?? '',
}
