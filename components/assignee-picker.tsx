'use client'
import { useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import type { JiraUser } from '@/lib/sources/jira'

const UNASSIGN = '__unassign__'

type Pending = { accountId: string | null; label: string }

export function AssigneePicker({ issueKey, current }: { issueKey: string; current: string }) {
  const [label, setLabel] = useState(current)
  const [users, setUsers] = useState<JiraUser[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  const loadUsers = async () => {
    if (users || loading) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/jira/assignable?key=${encodeURIComponent(issueKey)}`)
      const json = await res.json()
      setUsers(json.ok ? json.data : [])
      if (!json.ok) setError(json.message ?? 'Failed to load users')
    } catch {
      setUsers([])
      setError('Failed to load users')
    } finally {
      setLoading(false)
    }
  }

  // Selecting only proposes the change; the write happens after confirmation.
  const propose = (value: string) => {
    const accountId = value === UNASSIGN ? null : value
    const nextLabel = value === UNASSIGN ? 'Unassigned' : users?.find((u) => u.accountId === value)?.displayName ?? value
    setError(null)
    setPending({ accountId, label: nextLabel })
  }

  const doAssign = async (p: Pending) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/jira/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: issueKey, accountId: p.accountId }),
      })
      const json = await res.json()
      if (json.ok) setLabel(p.label)
      else setError(json.message ?? 'Reassign failed')
    } catch {
      setError('Reassign failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <Select onOpenChange={(o) => o && loadUsers()} onValueChange={propose} disabled={busy}>
        <SelectTrigger
          size="sm"
          className="h-5 max-w-[10rem] gap-1 border-0 bg-transparent px-1 font-mono text-[11px] text-muted-foreground shadow-none hover:text-foreground"
          title={`Reassign ${issueKey}`}
        >
          <SelectValue placeholder={label}>{busy ? 'saving…' : label}</SelectValue>
        </SelectTrigger>
        <SelectContent className="font-mono text-xs">
          {loading && <SelectItem value="__loading__" disabled>loading…</SelectItem>}
          <SelectItem value={UNASSIGN}>Unassigned</SelectItem>
          {users?.map((u) => (
            <SelectItem key={u.accountId} value={u.accountId}>{u.displayName}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <span className="font-mono text-[10px] text-destructive">{error}</span>}

      {pending && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60">
          <div className="space-y-3 rounded-none border border-border bg-card p-4 text-sm">
            <p className="font-mono">
              Reassign <span className="text-primary">{issueKey}</span> to{' '}
              <span className="text-primary">{pending.label}</span>?
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setPending(null)}>Cancel</Button>
              <Button size="sm"
                onClick={async () => { const p = pending; setPending(null); await doAssign(p) }}>Confirm</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
