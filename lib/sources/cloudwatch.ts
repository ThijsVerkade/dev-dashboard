import 'server-only'
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs'
import { env } from '@/lib/env'
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

function client() {
  return new CloudWatchLogsClient({ region: env.awsRegion() })
}

export async function getLogGroups(): Promise<Result<string[]>> {
  try {
    const configured = Object.values(dashboardConfig.cloudwatchLogGroups)
    if (configured.length > 0)
      return ok(configured)
    const out = await client().send(new DescribeLogGroupsCommand({ limit: 50 }))
    return ok((out.logGroups ?? []).map((g) => g.logGroupName!).filter(Boolean))
  } catch (e) {
    if (isMissingCreds(e))
      return unconfigured('AWS credentials not found. Configure ~/.aws or AWS_PROFILE/AWS_REGION.')
    return failure(e instanceof Error ? e.message : 'CloudWatch request failed')
  }
}

export async function getEvents(
  logGroup: string,
  startTime: number,
): Promise<Result<LogEvent[]>> {
  try {
    const out = await client().send(
      new FilterLogEventsCommand({ logGroupName: logGroup, startTime, limit: 200 }),
    )
    return ok((out.events ?? []).map(mapEvent))
  } catch (e) {
    if (isMissingCreds(e))
      return unconfigured('AWS credentials not found. Configure ~/.aws or AWS_PROFILE/AWS_REGION.')
    return failure(e instanceof Error ? e.message : 'CloudWatch request failed')
  }
}
