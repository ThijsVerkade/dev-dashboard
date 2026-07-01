'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PanelShell } from '@/components/panel-shell'
import { cn } from '@/lib/utils'
import type { SetupStatus, RepoState } from '@/lib/setup/repos'

const STATE_CLASS: Record<RepoState, string> = {
  present: 'text-primary border-primary/40',
  'present-not-git': 'text-amber-500 border-amber-500/40',
  missing: 'text-destructive border-destructive/40',
}
const STATE_LABEL: Record<RepoState, string> = {
  present: '● present',
  'present-not-git': '● not a git repo',
  missing: '● missing',
}

async function clone(repoName?: string) {
  const res = await fetch('/api/setup/repos/clone', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(repoName ? { repoName } : {}),
  })
  return res.json()
}

export function ReposPanel() {
  const { data, loading } = usePoll<SetupStatus>('/api/setup/repos', 15000)
  const [busy, setBusy] = useState<string | null>(null)

  async function run(repoName?: string) {
    setBusy(repoName ?? '*')
    try {
      await clone(repoName)
    } finally {
      setBusy(null)
    }
  }

  return (
    <PanelShell<SetupStatus> title="repos" result={data} loading={loading}>
      {(status) => {
        const missing = status.repos.filter((r) => r.state === 'missing')
        return (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-xs text-muted-foreground">root: {status.root}</p>
              {status.configured && missing.length > 0 && (
                <Button size="sm" disabled={busy !== null} onClick={() => run()}>
                  {busy === '*' ? 'Cloning…' : `Clone all missing (${missing.length})`}
                </Button>
              )}
            </div>
            {!status.configured && (
              <p className="font-mono text-sm text-amber-500">
                [ ---- ] set GITLAB_HOST and GITLAB_TOKEN (token scope: read_repository) to clone
              </p>
            )}
            <ul className="space-y-1">
              {status.repos.map((r) => (
                <li key={r.repoName} className="flex items-center justify-between gap-3 font-mono text-sm">
                  <span className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn('rounded-none bg-transparent px-1.5 text-[11px]', STATE_CLASS[r.state])}
                    >
                      {STATE_LABEL[r.state]}
                    </Badge>
                    <span>
                      {r.repoName}@{r.baseBranch}
                    </span>
                  </span>
                  {status.configured && r.state === 'missing' && (
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run(r.repoName)}>
                      {busy === r.repoName ? 'Cloning…' : 'Clone'}
                    </Button>
                  )}
                </li>
              ))}
              {status.repos.length === 0 && (
                <li className="font-mono text-sm text-muted-foreground">no repos configured — set AGENT_REPOS</li>
              )}
            </ul>
          </div>
        )
      }}
    </PanelShell>
  )
}
