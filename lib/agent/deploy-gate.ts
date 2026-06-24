import 'server-only'
import { getBoard } from '@/lib/sources/board'
import { getEvents } from '@/lib/sources/cloudwatch'
import { isCleanStartup } from '@/lib/agent/acceptance-logic'
import { type Result, ok, failure } from '@/lib/result'

const POLL_INTERVAL_MS = 15_000
const MAX_POLLS = 20 // ~5 minutes

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Find the board row for a ticket key (across all stage columns). */
async function findRow(key: string) {
  const board = await getBoard()
  if (!board.ok) return board
  const row = board.data.columns.flatMap((c) => c.rows).find((r) => r.key === key)
  return ok(row ?? null)
}

/**
 * Wait until the ticket's deploy:staging job is success, then confirm a clean
 * CloudWatch startup. Resolves with the project + (optional) staging log group.
 */
export async function checkStagingDeploy(key: string): Promise<Result<{ project: string; logGroup?: string }>> {
  let project = ''
  let logGroup: string | undefined

  for (let i = 0; i < MAX_POLLS; i++) {
    const r = await findRow(key)
    if (!r.ok) return r
    const row = r.data
    if (!row) return failure(`No board row for ${key} (is it in the current sprint?)`)
    if (!row.mr) return failure(`No merge request matched to ${key}; nothing is deployed`)
    project = row.repo?.project ?? project
    const stagingEnv = row.envs.find((e) => /staging/i.test(e.name))
    logGroup = stagingEnv?.logGroup

    if (row.stagingJob?.status === 'success') {
      if (!logGroup) return ok({ project }) // deploy green; no log group configured to verify
      const events = await getEvents(logGroup, Date.now() - 5 * 60 * 1000)
      if (!events.ok) return events
      if (!isCleanStartup(events.data))
        return failure('deploy:staging is green but the staging logs show errors or no startup')
      return ok({ project, logGroup })
    }
    await sleep(POLL_INTERVAL_MS)
  }
  return failure('timed out waiting for deploy:staging to go green')
}
