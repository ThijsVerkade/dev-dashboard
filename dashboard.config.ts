// Non-secret config: which resources the dashboard surfaces.
// Project ids/paths come from GITLAB_PROJECTS (comma-separated) if set,
// otherwise edit the defaults below.
const parseEnvList = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)

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
}
