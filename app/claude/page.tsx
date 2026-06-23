import { ClaudeLivePanel } from '@/components/claude-live'
import { ClaudePanel } from '@/components/claude-panel'

export default function ClaudePage() {
  return (
    <div className="space-y-4">
      <ClaudeLivePanel />
      <ClaudePanel />
    </div>
  )
}
