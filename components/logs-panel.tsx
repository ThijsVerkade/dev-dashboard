'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from './panel-shell'
import { LiveTail } from './live-tail'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function LogsPanel() {
  const { data, loading } = usePoll<string[]>('/api/cloudwatch/groups', 60000)
  const [group, setGroup] = useState('')
  return (
    <PanelShell title="CloudWatch Logs" result={data} loading={loading}>
      {(groups) => (
        <div className="space-y-3">
          <Select value={group} onValueChange={setGroup}>
            <SelectTrigger className="w-full max-w-md font-mono">
              <SelectValue placeholder="select a log group…" />
            </SelectTrigger>
            <SelectContent className="font-mono">
              {groups.map((g) => (
                <SelectItem key={g} value={g}>{g}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {group && <LiveTail src={`/api/cloudwatch/tail?group=${encodeURIComponent(group)}`} />}
        </div>
      )}
    </PanelShell>
  )
}
