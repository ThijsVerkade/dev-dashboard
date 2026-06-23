'use client'
import { useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { JiraUser } from '@/lib/sources/jira'

const UNASSIGN = '__unassign__'

export function AssigneePicker({ issueKey, current }: { issueKey: string; current: string }) {
  const [label, setLabel] = useState(current)
  const [users, setUsers] = useState<JiraUser[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const assign = async (value: string) => {
    const accountId = value === UNASSIGN ? null : value
    const nextLabel = value === UNASSIGN ? 'Unassigned' : users?.find((u) => u.accountId === value)?.displayName ?? label
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/jira/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: issueKey, accountId }),
      })
      const json = await res.json()
      if (json.ok) setLabel(nextLabel)
      else setError(json.message ?? 'Reassign failed')
    } catch {
      setError('Reassign failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <Select onOpenChange={(o) => o && loadUsers()} onValueChange={assign} disabled={busy}>
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
    </div>
  )
}
