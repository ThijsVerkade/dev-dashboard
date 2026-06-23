// Non-secret config: which resources the dashboard surfaces.
// Project ids/paths come from GITLAB_PROJECTS (comma-separated) if set,
// otherwise edit the defaults below.
const parseEnvList = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)

export const dashboardConfig = {
  gitlabProjects: parseEnvList(process.env.GITLAB_PROJECTS),
  gitlabGroups: parseEnvList(process.env.GITLAB_GROUPS),
  gitlabExcludes: parseEnvList(process.env.GITLAB_EXCLUDE),
  cloudwatchLogGroups: [] as string[], // e.g. ['/aws/lambda/my-fn']
  jiraProjects: parseEnvList(process.env.JIRA_PROJECTS),
}
