'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from '@/components/panel-shell'
import { LiveTail } from '@/components/live-tail'
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
            <p className="text-xs text-amber-600">Read-only GitLab token — actions disabled. Use an `api`-scoped token to enable merge/deploy/tag.</p>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {board.columns.map((col) => (
              <div key={col.status} className="space-y-2">
                <h3 className="text-sm font-semibold">{col.status} <span className="text-gray-400">({col.rows.length})</span></h3>
                {col.rows.map((row) => (
                  <div key={row.key} className="rounded border border-gray-200 dark:border-gray-800 p-2 text-xs space-y-1">
                    <div className="flex justify-between gap-2">
                      <a href={row.url} target="_blank" className="font-mono">{row.key}</a>
                      <span className="truncate text-gray-500">{row.assignee}</span>
                    </div>
                    <div className="truncate">{row.summary}</div>
                    <div className="font-mono text-[11px] text-gray-500">{flowStrip(row)}</div>
                    <div className="flex flex-wrap gap-1 pt-1">
                      {row.mr && (
                        <button
                          disabled={!board.canWrite || !row.readyToMerge}
                          title={!board.canWrite ? 'Needs api-scoped token' : !row.readyToMerge ? 'Not ready (approvals/pipeline/conflicts)' : ''}
                          className="rounded bg-green-600 px-2 py-0.5 text-white disabled:opacity-40"
                          onClick={() => confirm(`Merge MR !${row.mr!.iid} into main`, async () => {
                            setError(await post('/api/board/merge', { project: row.repo!.project, iid: row.mr!.iid }))
                          })}
                        >Merge</button>
                      )}
                      {row.stagingJob && (
                        <button
                          disabled={!board.canWrite || !row.stagingJob.playable}
                          title={!row.stagingJob.playable ? 'Pipeline not green or job not manual' : ''}
                          className="rounded bg-blue-600 px-2 py-0.5 text-white disabled:opacity-40"
                          onClick={() => confirm(`Play deploy:staging for ${row.key}`, async () => {
                            setError(await post('/api/board/deploy-staging', { project: row.repo!.project, sha: row.mr!.sha }))
                          })}
                        >Deploy staging</button>
                      )}
                      {row.repo && (
                        <button
                          disabled={!board.canWrite}
                          className="rounded bg-purple-600 px-2 py-0.5 text-white disabled:opacity-40"
                          onClick={() => {
                            const name = prompt('New production tag (on main):', row.suggestedTag ?? 'v0.1.0')
                            if (!name) return
                            confirm(`Create tag ${name} on main`, async () => {
                              setError(await post('/api/board/tag', { project: row.repo!.project, name }))
                            })
                          }}
                        >Cut tag</button>
                      )}
                      {row.envs.filter((e) => e.onThisTicket && e.logGroup).map((e) => (
                        <button key={e.name} className="rounded border px-2 py-0.5"
                          onClick={() => setTailGroup(e.logGroup!)}>logs: {e.name}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {tailGroup && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs"><span className="font-mono">{tailGroup}</span>
                <button onClick={() => setTailGroup(null)}>close</button></div>
              <LiveTail src={`/api/cloudwatch/tail?group=${encodeURIComponent(tailGroup)}`} />
            </div>
          )}

          {pending && (
            <div className="fixed inset-0 flex items-center justify-center bg-black/40">
              <div className="space-y-3 rounded bg-white p-4 text-sm dark:bg-gray-900">
                <p>{pending.label}?</p>
                <div className="flex justify-end gap-2">
                  <button className="rounded border px-3 py-1" onClick={() => setPending(null)}>Cancel</button>
                  <button className="rounded bg-blue-600 px-3 py-1 text-white"
                    onClick={async () => { const p = pending; setPending(null); setError(null); await p.run() }}>Confirm</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </PanelShell>
  )
}
