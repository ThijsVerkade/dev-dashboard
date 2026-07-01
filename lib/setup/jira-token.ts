import { type Result, ok, failure } from '@/lib/result'
import { persistEnvVars } from '@/lib/setup/gitlab-token'

/**
 * Verify Jira credentials with a cheap `GET /rest/api/3/myself` call (Basic auth,
 * base64(email:token)). The token travels in the Authorization header, never the URL,
 * so it cannot leak into an error string.
 */
export async function validateJiraCreds(
  host: string,
  email: string,
  token: string,
): Promise<Result<null>> {
  const base = host.replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/rest/api/3/myself`, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64'),
        Accept: 'application/json',
      },
    })
    if (res.ok) return ok(null)
    if (res.status === 401 || res.status === 403)
      return failure('Jira rejected these credentials (check the email and API token).')
    return failure(`Jira check failed (HTTP ${res.status}).`)
  } catch (e) {
    return failure(e instanceof Error ? `Could not reach Jira: ${e.message}` : 'Could not reach Jira.')
  }
}

/** Validate Jira creds, then persist JIRA_HOST/JIRA_EMAIL/JIRA_TOKEN to .env.local + process.env. */
export async function saveJiraCreds(
  host: string,
  email: string,
  token: string,
): Promise<Result<null>> {
  if (!host || !email || !token) return failure('Jira host, email, and API token are all required.')
  const check = await validateJiraCreds(host, email, token)
  if (!check.ok) return check
  return persistEnvVars({ JIRA_HOST: host, JIRA_EMAIL: email, JIRA_TOKEN: token })
}
