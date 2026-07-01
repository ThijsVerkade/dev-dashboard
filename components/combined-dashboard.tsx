'use client'
import { useIsMobile } from '@/hooks/use-mobile'
import { ClaudeActivity } from '@/components/claude-activity'
import { LogsPanel } from '@/components/logs-panel'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable'

export function CombinedDashboard() {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-[70vh]">
          <ClaudeActivity />
        </div>
        <LogsPanel />
      </div>
    )
  }

  return (
    <ResizablePanelGroup direction="horizontal" autoSaveId="dashboard-h" className="min-h-0 flex-1">
      <ResizablePanel id="claude" order={1} defaultSize={45} minSize={25}>
        <ClaudeActivity />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="logs" order={2} defaultSize={55} minSize={25}>
        <div className="h-full overflow-y-auto pl-4">
          <LogsPanel />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
