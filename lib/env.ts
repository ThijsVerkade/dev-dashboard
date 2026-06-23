import 'server-only'

export const env = {
  gitlab(): { host: string; token: string } | null {
    const host = process.env.GITLAB_HOST
    const token = process.env.GITLAB_TOKEN
    if (!host || !token) return null
    return { host, token }
  },
  awsRegion(): string | undefined {
    return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION
  },
  jira(): { host: string; email: string; token: string } | null {
    const host = process.env.JIRA_HOST
    const email = process.env.JIRA_EMAIL
    const token = process.env.JIRA_TOKEN
    if (!host || !email || !token) return null
    return { host, email, token }
  },
}
