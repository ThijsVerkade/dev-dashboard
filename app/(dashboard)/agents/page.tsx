import { AgentsPanel } from '@/components/agents-panel'
import { ClaudePanel } from '@/components/claude-panel'

export default function AgentsPage() {
  return (
    <div className="space-y-4">
      <AgentsPanel />
      <ClaudePanel />
    </div>
  )
}
