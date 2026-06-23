'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from './panel-shell'
import { LiveTail } from './live-tail'

export function LogsPanel() {
  const { data, loading } = usePoll<string[]>('/api/cloudwatch/groups', 60000)
  const [group, setGroup] = useState('')
  return (
    <PanelShell title="CloudWatch Logs" result={data} loading={loading}>
      {(groups) => (
        <div className="space-y-3">
          <select className="rounded border p-1 text-sm" value={group}
            onChange={(e) => setGroup(e.target.value)}>
            <option value="">Select a log group…</option>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          {group && <LiveTail src={`/api/cloudwatch/tail?group=${encodeURIComponent(group)}`} />}
        </div>
      )}
    </PanelShell>
  )
}
