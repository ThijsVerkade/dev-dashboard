import 'server-only'
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs'
import { fromIni } from '@aws-sdk/credential-provider-ini'
import { dashboardConfig } from '@/dashboard.config'
import { Result, ok, unconfigured, failure } from '@/lib/result'

export type LogEvent = { id: string; timestamp: number; message: string }

export function mapEvent(raw: { eventId?: string; timestamp?: number; message?: string }): LogEvent {
  return {
    id: raw.eventId ?? '',
    timestamp: raw.timestamp ?? 0,
    message: (raw.message ?? '').replace(/\n+$/, ''),
  }
}

export function isMissingCreds(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? ''
  return name === 'CredentialsProviderError' || name === 'CredentialsError'
}

const ENV_TOKENS = ['dev', 'stg', 'prod'] as const

/** Parse an App Runner service name "<domain>-<service>-<env>". */
export function parseServiceName(serviceName: string): { domain: string; service: string; env?: string } {
  const parts = serviceName.split('-')
  const last = parts[parts.length - 1]
  const env = (ENV_TOKENS as readonly string[]).includes(last) ? last : undefined
  const core = env ? parts.slice(0, -1) : parts
  const [domain, ...rest] = core
  return { domain: domain ?? '', service: rest.join('-'), env }
}

const SERVICE_LABELS: Record<string, string> = {
  frontend: 'fe',
  'erp-frontend': 'fe-erp',
  bff: 'bff',
  'erp-bff': 'bff-erp',
  api: 'api',
}

/** Friendly label for a raw service, passing unknown values through unchanged. */
export function serviceLabel(rawService: string): string {
  return SERVICE_LABELS[rawService] ?? rawService
}

function client(env: string) {
  const profile = dashboardConfig.cloudwatchEnvProfiles[env]
  return new CloudWatchLogsClient({
    region: dashboardConfig.cloudwatchRegion,
    credentials: profile ? fromIni({ profile }) : undefined,
  })
}

export type ServiceMap = Record<string, Record<string, string>>

/** Pure: build domain -> { label -> logGroupName } from raw `/application` group names. */
export function buildServiceMap(groupNames: string[]): ServiceMap {
  const map: ServiceMap = {}
  for (const name of groupNames) {
    if (!name.endsWith('/application')) continue
    const serviceName = name.slice('/aws/apprunner/'.length).split('/')[0]
    const { domain, service } = parseServiceName(serviceName)
    if (!domain) continue
    ;(map[domain] ??= {})[serviceLabel(service)] = name
  }
  return map
}

/** Environment names available for log viewing (config keys, or single 'dev' fallback). */
export function logEnvironments(): string[] {
  const keys = Object.keys(dashboardConfig.cloudwatchEnvProfiles)
  return keys.length > 0 ? keys : ['dev']
}

export async function getServiceMap(env: string): Promise<Result<ServiceMap>> {
  try {
    const c = client(env)
    const names: string[] = []
    let nextToken: string | undefined
    do {
      const out = await c.send(
        new DescribeLogGroupsCommand({ logGroupNamePrefix: '/aws/apprunner/', nextToken }),
      )
      for (const g of out.logGroups ?? []) if (g.logGroupName) names.push(g.logGroupName)
      nextToken = out.nextToken
    } while (nextToken)
    return ok(buildServiceMap(names))
  } catch (e) {
    if (isMissingCreds(e))
      return unconfigured(`AWS credentials for "${env}" not found. Check the profile / re-auth (SSO).`)
    return failure(e instanceof Error ? e.message : 'CloudWatch request failed')
  }
}

export async function getEvents(
  logGroup: string,
  startTime: number,
  env: string,
): Promise<Result<LogEvent[]>> {
  try {
    const out = await client(env).send(
      new FilterLogEventsCommand({ logGroupName: logGroup, startTime, limit: 200 }),
    )
    return ok((out.events ?? []).map(mapEvent))
  } catch (e) {
    if (isMissingCreds(e))
      return unconfigured(`AWS credentials for "${env}" not found. Check the profile / re-auth (SSO).`)
    return failure(e instanceof Error ? e.message : 'CloudWatch request failed')
  }
}
