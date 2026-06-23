'use client'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from './panel-shell'
import type { ClaudeSummary, ClaudeSession } from '@/lib/sources/claude'

export function ClaudePanel() {
  const summary = usePoll<ClaudeSummary>('/api/claude/summary', 60000)
  const sessions = usePoll<ClaudeSession[]>('/api/claude/sessions', 60000)
  return (
    <PanelShell title="Claude Activity" result={summary.data} loading={summary.loading}>
      {(s) => (
        <div className="space-y-3 text-sm">
          <div className="flex gap-4">
            <div className="rounded border p-3">
              <div className="text-xs text-gray-500">Total cost</div>
              <div className="text-xl font-semibold">${s.totalCost.toFixed(2)}</div>
            </div>
            <div className="rounded border p-3">
              <div className="text-xs text-gray-500">Total tokens</div>
              <div className="text-xl font-semibold">{s.totalTokens.toLocaleString()}</div>
            </div>
          </div>
          {sessions.data?.ok && (
            <table className="w-full text-left">
              <thead><tr className="text-xs text-gray-500">
                <th>Project</th><th>Last activity</th><th className="text-right">Tokens</th><th className="text-right">Cost</th>
              </tr></thead>
              <tbody>
                {sessions.data.data.slice(0, 15).map((row) => (
                  <tr key={row.sessionId} className="border-t">
                    <td>{row.project || row.sessionId.slice(0, 8)}</td>
                    <td>{row.lastActivity}</td>
                    <td className="text-right">{row.tokens.toLocaleString()}</td>
                    <td className="text-right">${row.cost.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </PanelShell>
  )
}
