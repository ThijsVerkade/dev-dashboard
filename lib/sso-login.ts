// Pure helpers for the local-only "trigger AWS SSO login" route.
// Kept free of I/O so the host guard and profile resolution are unit-tested;
// the actual `aws sso login` spawn lives in the route handler.

/** True only for loopback request hosts (optionally with a :port). */
export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1) // IPv6 literal, e.g. "[::1]" from "[::1]:3000"
    : host.split(':')[0]
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/** AWS named profile configured for an env, or undefined if none. */
export function loginProfileForEnv(env: string, profiles: Record<string, string>): string | undefined {
  return profiles[env] || undefined
}

/**
 * Args for a profile-scoped SSO login. Using --profile (not --sso-session)
 * lets the AWS CLI derive the session from the profile, so it works whether or
 * not AWS_SSO_SESSION is set.
 */
export function ssoLoginArgs(profile: string): string[] {
  return ['sso', 'login', '--profile', profile]
}
