import { PipelinesPanel } from '@/components/pipelines-panel'
import { LogsPanel } from '@/components/logs-panel'
import { ClaudePanel } from '@/components/claude-panel'

export default function Home() {
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">dev-dashboard</h1>
      <div className="grid gap-6 lg:grid-cols-2">
        <PipelinesPanel />
        <ClaudePanel />
        <div className="lg:col-span-2"><LogsPanel /></div>
      </div>
    </main>
  )
}
