'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from './panel-shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Issue } from '@/lib/sources/jira'

type Tab = 'mine' | 'sprint' | 'recent'

function statusCategoryClass(cat: string): string {
  if (cat === 'indeterminate') return 'text-primary border-primary/40'
  if (cat === 'done') return 'text-primary border-primary/40'
  return 'text-muted-foreground border-border'
}

function IssueList({ issues }: { issues: Issue[] }) {
  return (
    <div className="space-y-2">
      {issues.map((issue) => (
        <div key={issue.key} className="flex items-start gap-2 text-sm">
          <Badge
            variant="outline"
            className={cn('mt-0.5 shrink-0 rounded-none bg-transparent font-mono text-[11px]', statusCategoryClass(issue.statusCategory))}
          >
            {issue.status || issue.statusCategory}
          </Badge>
          <div className="min-w-0 flex-1">
            <a
              href={issue.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-primary hover:underline"
            >
              {issue.key}
            </a>{' '}
            <span className="max-w-xs truncate">{issue.summary}</span>
            <div className="text-xs text-muted-foreground">{issue.assignee}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function JiraPanel() {
  const [tab, setTab] = useState<Tab>('mine')

  const mine = usePoll<Issue[]>('/api/jira/my', 60000)
  const sprint = usePoll<Issue[]>('/api/jira/sprint', 60000)
  const recent = usePoll<Issue[]>('/api/jira/recent', 60000)

  const active = tab === 'mine' ? mine : tab === 'sprint' ? sprint : recent

  return (
    <PanelShell title="Jira" result={active.data} loading={active.loading}>
      {(issues) => (
        <div>
          <div className="mb-3 flex gap-1">
            {(['mine', 'sprint', 'recent'] as const).map((t) => (
              <Button
                key={t}
                size="sm"
                variant={tab === t ? 'secondary' : 'ghost'}
                className="h-7 px-2 font-mono text-xs"
                onClick={() => setTab(t)}
              >
                {t}
              </Button>
            ))}
          </div>
          <IssueList issues={issues} />
        </div>
      )}
    </PanelShell>
  )
}
