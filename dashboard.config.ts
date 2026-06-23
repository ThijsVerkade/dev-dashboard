// Non-secret config: which resources the dashboard surfaces.
// Project ids/paths come from GITLAB_PROJECTS (comma-separated) if set,
// otherwise edit the defaults below.
const fromEnv = (process.env.GITLAB_PROJECTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export const dashboardConfig = {
  gitlabProjects: fromEnv.length > 0 ? fromEnv : ([] as string[]),
  cloudwatchLogGroups: [] as string[], // e.g. ['/aws/lambda/my-fn']
}
