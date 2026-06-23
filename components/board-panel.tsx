'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from '@/components/panel-shell'
import { LiveTail } from '@/components/live-tail'
import { AssigneePicker } from '@/components/assignee-picker'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Board, BoardRow } from '@/lib/sources/board'

type Pending = { label: string; run: () => Promise<void> } | null

const ENVS = ['dev', 'acceptance', 'staging', 'production'] as const
const ENV_SHORT: Record<string, string> = { dev: 'D', acceptance: 'A', staging: 'S', production: 'P' }

function pipelineTone(status?: string): string {
  if (status === 'success') return 'text-primary'
  if (status === 'failed') return 'text-destructive'
  if (status === 'running' || status === 'pending') return 'text-amber-500'
  return 'text-muted-foreground'
}

function FlowPills({ row }: { row: BoardRow }) {
  const mr = row.mr
  const apprOk = mr ? mr.approvalsGiven >= mr.approvalsRequired : false
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px]">
      <span className={mr ? 'text-primary' : 'text-muted-foreground'}>br{mr ? '✓' : '·'}</span>
      <span className={mr ? 'text-primary' : 'text-muted-foreground'}>mr{mr ? '✓' : '·'}</span>
      {mr && (
        <span className={apprOk ? 'text-primary' : 'text-amber-500'} title="approvals">
          apr {mr.approvalsGiven}/{mr.approvalsRequired}
        </span>
      )}
      {mr && (
        <span className={pipelineTone(mr.pipelineStatus)} title={`pipeline ${mr.pipelineStatus ?? 'none'}`}>
          pl {mr.pipelineStatus ? mr.pipelineStatus.slice(0, 4) : '·'}
        </span>
      )}
      <span className="ml-1 flex items-center gap-1 text-muted-foreground" title="dev / acceptance / staging / production">
        {ENVS.map((name) => {
          const on = row.envs.some((e) => e.name === name && e.onThisTicket)
          return (
            <span key={name} className={on ? 'text-primary' : 'text-muted-foreground/40'}>
              {ENV_SHORT[name]}
            </span>
          )
        })}
      </span>
    </div>
  )
}

async function post(url: string, body: unknown): Promise<string | null> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json()
  return json.ok ? null : json.message ?? 'Action failed'
}

export function BoardPanel() {
  const { data, loading } = usePoll<Board>('/api/board', 30_000)
  const [pending, setPending] = useState<Pending>(null)
  const [tailGroup, setTailGroup] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const confirm = (label: string, run: () => Promise<void>) => setPending({ label, run })

  return (
    <PanelShell<Board> title="Release Flow" result={data} loading={loading}>
      {(board) => (
        <div className="space-y-3">
          {!board.canWrite && (
            <p className="font-mono text-[11px] text-amber-500">[ ---- ] read-only GitLab token — merge/deploy/tag disabled.</p>
          )}
          {error && <p className="font-mono text-xs text-destructive">[ FAIL ] {error}</p>}
          <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {board.columns.map((col) => (
              <div key={col.status} className="space-y-1.5">
                <h3 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {col.status} <span className="text-muted-foreground/60">({col.rows.length})</span>
                </h3>
                {col.rows.map((row) => (
                  <div key={row.key} className="space-y-1 rounded-none border border-border bg-card/60 p-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <a href={row.url} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-primary hover:underline">{row.key}</a>
                      <AssigneePicker issueKey={row.key} current={row.assignee} />
                    </div>
                    <div className="truncate text-foreground/90" title={row.summary}>{row.summary}</div>
                    <FlowPills row={row} />
                    {(row.mr || row.repo || row.envs.some((e) => e.onThisTicket && e.logGroup)) && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {row.mr && (
                          <Button
                            size="sm"
                            disabled={!board.canWrite || !row.readyToMerge}
                            title={!board.canWrite ? 'Needs api-scoped token' : !row.readyToMerge ? 'Not ready (approvals/pipeline/conflicts)' : ''}
                            className="h-5 px-1.5 text-[10px]"
                            onClick={() => confirm(`Merge MR !${row.mr!.iid} into main`, async () => {
                              setError(await post('/api/board/merge', { project: row.repo!.project, iid: row.mr!.iid }))
                            })}
                          >Merge</Button>
                        )}
                        {row.stagingJob && row.mr && row.repo && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!board.canWrite || !row.stagingJob.playable}
                            title={!row.stagingJob.playable ? 'Pipeline not green or job not manual' : ''}
                            className="h-5 px-1.5 text-[10px]"
                            onClick={() => confirm(`Play deploy:staging for ${row.key}`, async () => {
                              setError(await post('/api/board/deploy-staging', { project: row.repo!.project, sha: row.mr!.sha }))
                            })}
                          >Staging</Button>
                        )}
                        {row.repo && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!board.canWrite}
                            className="h-5 px-1.5 text-[10px]"
                            onClick={() => {
                              const name = prompt('New production tag (on main):', row.suggestedTag ?? 'v0.1.0')
                              if (!name) return
                              confirm(`Create tag ${name} on main`, async () => {
                                setError(await post('/api/board/tag', { project: row.repo!.project, name }))
                              })
                            }}
                          >Tag</Button>
                        )}
                        {row.envs.filter((e) => e.onThisTicket && e.logGroup).map((e) => (
                          <Button key={e.name} size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]"
                            onClick={() => setTailGroup(e.logGroup!)}>log:{ENV_SHORT[e.name] ?? e.name}</Button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {tailGroup && (
            <div className="space-y-1">
              <div className="flex justify-between font-mono text-xs"><span>{tailGroup}</span>
                <button className="text-muted-foreground hover:text-foreground" onClick={() => setTailGroup(null)}>close</button></div>
              <LiveTail src={`/api/cloudwatch/tail?group=${encodeURIComponent(tailGroup)}`} />
            </div>
          )}

          {pending && (
            <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60">
              <div className={cn('space-y-3 rounded-none border border-border bg-card p-4 text-sm')}>
                <p className="font-mono">{pending.label}?</p>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => setPending(null)}>Cancel</Button>
                  <Button size="sm"
                    onClick={async () => { const p = pending; setPending(null); setError(null); await p.run() }}>Confirm</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </PanelShell>
  )
}
