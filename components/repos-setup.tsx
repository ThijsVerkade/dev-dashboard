'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PanelShell } from '@/components/panel-shell'
import { cn } from '@/lib/utils'
import { createTokenUrl, createJiraTokenUrl } from '@/lib/setup/repos-client'
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

type RowRun = { state: 'cloning' | 'done' | 'error'; message?: string }

type CloneResult =
  | { ok: true; data: { branch: string; warning?: string } }
  | { ok: false; message: string }

async function cloneOne(repoName: string, force: boolean): Promise<CloneResult> {
  try {
    const res = await fetch('/api/setup/repos/clone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoName, force }),
    })
    const json = await res.json()
    // Route returns ok([{ repoName, result }]); unwrap the single result.
    if (json?.ok && Array.isArray(json.data) && json.data[0]?.result) return json.data[0].result
    if (json && json.ok === false) return json // route-level unconfigured/error
    return { ok: false, message: 'Unexpected clone response.' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Clone request failed.' }
  }
}

function TokenForm({ host: initialHost }: { host: string }) {
  const [host, setHost] = useState(initialHost)
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/setup/gitlab-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host, token }),
      })
      const json = await res.json()
      if (!json?.ok) setError(json?.message ?? 'Could not save the token.')
      else setToken('') // poll will flip `configured` to true and swap this form out
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="font-mono text-sm text-amber-500">
        Set a GitLab token to clone your repositories and load pipelines.
      </p>
      <p className="font-mono text-[11px] text-muted-foreground">
        Scopes: <code>api</code> + <code>read_repository</code> for everything (pipelines, cloning,
        triggering jobs &amp; posting MR notes). Read-only alternative: <code>read_api</code> +{' '}
        <code>read_repository</code> — but job triggers and MR comments will fail.
      </p>
      <a
        href={createTokenUrl(host)}
        target="_blank"
        rel="noreferrer"
        className="inline-block font-mono text-sm text-primary underline hover:opacity-80"
      >
        Create a token in GitLab →
      </a>
      <p className="font-mono text-[11px] text-muted-foreground">
        On older GitLab, use <code>/-/profile/personal_access_tokens</code> instead.
      </p>
      <label className="block space-y-1">
        <span className="font-mono text-xs text-muted-foreground">GitLab host</span>
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          className="h-9 w-full rounded-none border border-border bg-background px-2 font-mono text-sm"
        />
      </label>
      <label className="block space-y-1">
        <span className="font-mono text-xs text-muted-foreground">Personal access token</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="glpat-…"
          className="h-9 w-full rounded-none border border-border bg-background px-2 font-mono text-sm"
        />
      </label>
      {error && <p className="font-mono text-sm text-destructive">[ FAIL ] {error}</p>}
      <Button size="sm" disabled={saving || !token} onClick={save}>
        {saving ? 'Validating…' : 'Save token'}
      </Button>
    </div>
  )
}

function JiraForm({ host: initialHost }: { host: string }) {
  const [host, setHost] = useState(initialHost)
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/setup/jira', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host, email, token }),
      })
      const json = await res.json()
      if (!json?.ok) setError(json?.message ?? 'Could not save the Jira credentials.')
      else setToken('') // poll will flip `jiraConfigured` to true and swap this form out
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <p className="font-mono text-sm text-amber-500">
        Connect Jira (host + account email + API token) to load the board.
      </p>
      <p className="font-mono text-[11px] text-muted-foreground">
        Classic API tokens need no scopes — they inherit your account&apos;s Jira permissions
        (Browse Projects to read the board; Assign/Edit Issues &amp; Add Comments for board actions).
      </p>
      <a
        href={createJiraTokenUrl()}
        target="_blank"
        rel="noreferrer"
        className="inline-block font-mono text-sm text-primary underline hover:opacity-80"
      >
        Create an API token in Jira →
      </a>
      <label className="block space-y-1">
        <span className="font-mono text-xs text-muted-foreground">Jira host</span>
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="https://your-org.atlassian.net"
          className="h-9 w-full rounded-none border border-border bg-background px-2 font-mono text-sm"
        />
      </label>
      <label className="block space-y-1">
        <span className="font-mono text-xs text-muted-foreground">Account email</span>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className="h-9 w-full rounded-none border border-border bg-background px-2 font-mono text-sm"
        />
      </label>
      <label className="block space-y-1">
        <span className="font-mono text-xs text-muted-foreground">API token</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="h-9 w-full rounded-none border border-border bg-background px-2 font-mono text-sm"
        />
      </label>
      {error && <p className="font-mono text-sm text-destructive">[ FAIL ] {error}</p>}
      <Button size="sm" disabled={saving || !host || !email || !token} onClick={save}>
        {saving ? 'Validating…' : 'Connect Jira'}
      </Button>
    </div>
  )
}

function ObsidianForm() {
  const [host, setHost] = useState('http://127.0.0.1:27123')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/setup/obsidian', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host, token }),
      })
      const json = await res.json()
      if (!json?.ok) setError(json?.message ?? 'Could not save the Obsidian settings.')
      else {
        setSaved(true)
        setToken('')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <p className="font-mono text-sm text-amber-500">
        Connect Obsidian so agents can read/write the knowledge vault via the Local REST API.
      </p>
      <p className="font-mono text-[11px] text-muted-foreground">
        In Obsidian: install &amp; enable <strong>Local REST API</strong>, turn on its{' '}
        <code>Non-encrypted (HTTP) Server</code>, and copy the API key. This validates it and saves it to{' '}
        <code>.env.local</code>; the MCP itself loads on the next Claude&nbsp;Code restart (needs{' '}
        <code>OBSIDIAN_API_KEY</code> in your shell env).
      </p>
      <label className="block space-y-1">
        <span className="font-mono text-xs text-muted-foreground">Obsidian host</span>
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="http://127.0.0.1:27123"
          className="h-9 w-full rounded-none border border-border bg-background px-2 font-mono text-sm"
        />
      </label>
      <label className="block space-y-1">
        <span className="font-mono text-xs text-muted-foreground">API key</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="h-9 w-full rounded-none border border-border bg-background px-2 font-mono text-sm"
        />
      </label>
      {error && <p className="font-mono text-sm text-destructive">[ FAIL ] {error}</p>}
      {saved && (
        <p className="font-mono text-sm text-primary">
          [ OK ] Validated &amp; saved. Restart Claude Code to load the Obsidian MCP.
        </p>
      )}
      <Button size="sm" disabled={saving || !host || !token} onClick={save}>
        {saving ? 'Validating…' : 'Connect Obsidian'}
      </Button>
    </div>
  )
}

export function ReposSetup() {
  const { data, loading } = usePoll<SetupStatus>('/api/setup/repos', 5000)
  const [runs, setRuns] = useState<Record<string, RowRun>>({})
  const [busy, setBusy] = useState(false)

  async function run(repoName: string, force: boolean) {
    setBusy(true)
    setRuns((r) => ({ ...r, [repoName]: { state: 'cloning' } }))
    const res = await cloneOne(repoName, force)
    setRuns((r) => ({
      ...r,
      [repoName]: res.ok
        ? { state: 'done', message: res.data.warning }
        : { state: 'error', message: res.message },
    }))
    setBusy(false)
  }

  async function runAll(repoNames: string[]) {
    setBusy(true)
    for (const name of repoNames) {
      setRuns((r) => ({ ...r, [name]: { state: 'cloning' } }))
      const res = await cloneOne(name, false)
      setRuns((r) => ({
        ...r,
        [name]: res.ok
          ? { state: 'done', message: res.data.warning }
          : { state: 'error', message: res.message },
      }))
    }
    setBusy(false)
  }

  return (
    <PanelShell<SetupStatus> title="repos" result={data} loading={loading}>
      {(status) => {
        const missing = status.repos.filter((r) => r.state === 'missing')
        return (
          <div className="space-y-4">
            {!status.configured ? (
              <TokenForm host={status.host} />
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-xs text-muted-foreground">root: {status.root}</p>
              {missing.length > 0 && (
                <Button size="sm" disabled={busy} onClick={() => runAll(missing.map((m) => m.repoName))}>
                  {busy ? 'Cloning…' : `Clone all missing (${missing.length})`}
                </Button>
              )}
            </div>
            <ul className="space-y-1">
              {status.repos.map((r) => {
                const runState = runs[r.repoName]
                return (
                  <li key={r.repoName} className="flex flex-col gap-0.5 font-mono text-sm">
                    <div className="flex items-center justify-between gap-3">
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
                      {r.state === 'missing' && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(r.repoName, false)}>
                          {runState?.state === 'cloning' ? 'Cloning…' : 'Clone'}
                        </Button>
                      )}
                      {r.state === 'present-not-git' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            if (confirm(`This deletes ${r.path} and re-clones. Continue?`)) run(r.repoName, true)
                          }}
                        >
                          {runState?.state === 'cloning' ? 'Cloning…' : 'Re-clone'}
                        </Button>
                      )}
                    </div>
                    {runState?.state === 'error' && (
                      <span className="text-destructive">[ FAIL ] {runState.message}</span>
                    )}
                    {runState?.state === 'done' && runState.message && (
                      <span className="text-amber-500">⚠ {runState.message}</span>
                    )}
                  </li>
                )
              })}
              {status.repos.length === 0 && (
                <li className="font-mono text-sm text-muted-foreground">no repos configured — set AGENT_REPOS</li>
              )}
                </ul>
              </div>
            )}
            {!status.jiraConfigured && <JiraForm host={status.jiraHost} />}
            <ObsidianForm />
          </div>
        )
      }}
    </PanelShell>
  )
}
