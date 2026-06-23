import { BoardPanel } from '@/components/board-panel'
import { PipelinesPanel } from '@/components/pipelines-panel'
import { LogsPanel } from '@/components/logs-panel'
import { ClaudePanel } from '@/components/claude-panel'
import { JiraPanel } from '@/components/jira-panel'
import { AppSidebar } from '@/components/app-sidebar'
import { CommandPalette } from '@/components/command-palette'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb'
import { Separator } from '@/components/ui/separator'
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'

export default function Home() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage className="font-mono">
                  <span className="text-muted-foreground">~/ops $ </span>
                  <span className="text-primary">dev-dashboard</span>
                  <span className="terminal-cursor" aria-hidden>█</span>
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto">
            <CommandPalette />
          </div>
        </header>

        <main className="flex flex-1 flex-col gap-6 p-4 md:p-6">
          <section id="board" className="scroll-mt-16">
            <BoardPanel />
          </section>
          <div className="grid gap-6 lg:grid-cols-2">
            <section id="pipelines" className="scroll-mt-16">
              <PipelinesPanel />
            </section>
            <section id="claude" className="scroll-mt-16">
              <ClaudePanel />
            </section>
            <section id="jira" className="scroll-mt-16">
              <JiraPanel />
            </section>
            <section id="logs" className="scroll-mt-16 lg:col-span-2">
              <LogsPanel />
            </section>
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
