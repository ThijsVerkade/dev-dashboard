'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from '@/components/panel-shell'
import { LiveTail } from '@/components/live-tail'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import type { Board, BoardRow } from '@/lib/sources/board'

type Pending = { label: string; run: () => Promise<void> } | null

function flowStrip(row: BoardRow): string {
  const mark = (ok: boolean) => (ok ? '✓' : '–')
  const mr = row.mr
  const env = (name: string) => `${name} ${mark(row.envs.some((e) => e.name === name && e.onThisTicket))}`
  return [
    `branch ${mark(Boolean(mr))}`,
    `MR ${mark(Boolean(mr))}`,
    mr ? `approvals ${mr.approvalsGiven}/${mr.approvalsRequired}` : 'approvals –',
    `pipeline ${mr?.pipelineStatus ?? '–'}`,
    env('dev'), env('acceptance'), env('staging'), env('production'),
  ].join(' · ')
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
        <div className="space-y-4">
          {!board.canWrite && (
            <p className="font-mono text-xs text-amber-500">[ ---- ] read-only GitLab token — actions disabled. Use an `api`-scoped token to enable merge/deploy/tag.</p>
          )}
          {error && <p className="font-mono text-xs text-destructive">[ FAIL ] {error}</p>}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {board.columns.map((col) => (
              <div key={col.status} className="space-y-2">
                <h3 className="font-mono text-sm font-semibold">{col.status} <span className="text-muted-foreground">({col.rows.length})</span></h3>
                {col.rows.map((row) => (
                  <Card key={row.key} className="gap-1 rounded-none border-border p-2 text-xs">
                    <div className="flex justify-between gap-2">
                      <a href={row.url} target="_blank" rel="noreferrer" className="font-mono text-primary hover:underline">{row.key}</a>
                      <span className="truncate text-muted-foreground">{row.assignee}</span>
                    </div>
                    <div className="truncate">{row.summary}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{flowStrip(row)}</div>
                    <div className="flex flex-wrap gap-1 pt-1">
                      {row.mr && (
                        <Button
                          size="sm"
                          disabled={!board.canWrite || !row.readyToMerge}
                          title={!board.canWrite ? 'Needs api-scoped token' : !row.readyToMerge ? 'Not ready (approvals/pipeline/conflicts)' : ''}
                          className="h-6 px-2 text-xs"
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
                          className="h-6 px-2 text-xs"
                          onClick={() => confirm(`Play deploy:staging for ${row.key}`, async () => {
                            setError(await post('/api/board/deploy-staging', { project: row.repo!.project, sha: row.mr!.sha }))
                          })}
                        >Deploy staging</Button>
                      )}
                      {row.repo && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!board.canWrite}
                          className="h-6 px-2 text-xs"
                          onClick={() => {
                            const name = prompt('New production tag (on main):', row.suggestedTag ?? 'v0.1.0')
                            if (!name) return
                            confirm(`Create tag ${name} on main`, async () => {
                              setError(await post('/api/board/tag', { project: row.repo!.project, name }))
                            })
                          }}
                        >Cut tag</Button>
                      )}
                      {row.envs.filter((e) => e.onThisTicket && e.logGroup).map((e) => (
                        <Button key={e.name} size="sm" variant="ghost" className="h-6 px-2 text-xs"
                          onClick={() => setTailGroup(e.logGroup!)}>logs: {e.name}</Button>
                      ))}
                    </div>
                  </Card>
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
              <Card className="gap-3 rounded-none border-border bg-card p-4 text-sm">
                <p className="font-mono">{pending.label}?</p>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => setPending(null)}>Cancel</Button>
                  <Button size="sm"
                    onClick={async () => { const p = pending; setPending(null); setError(null); await p.run() }}>Confirm</Button>
                </div>
              </Card>
            </div>
          )}
        </div>
      )}
    </PanelShell>
  )
}
