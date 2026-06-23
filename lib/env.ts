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
}
